import type { Session } from "./guest-auth.ts";
import { filterDashboard, redactConfig } from "./redact.ts";
import { isEntityId, type Scope } from "./scope.ts";

type Message = Record<string, unknown>;

export type InboundDecision =
  | { action: "forward"; message: Message; kind: string }
  | { action: "reply"; message: Message; kind?: string; events?: Message[] }
  | { action: "close" };

type ReplyDecision = Extract<InboundDecision, { action: "reply" }>;

export type KindOf = (id: number) => string | undefined;

type InboundRule = (msg: Message, id: number, session: Session, kindOf: KindOf) => InboundDecision;
type ResultFilter = (result: unknown, session: Session) => unknown;
type EventFilter = (data: unknown, scope: Scope) => unknown;

const NAME = /^[a-z0-9_]+$/;
const TOGGLE_SERVICES = new Set(["turn_on", "turn_off", "toggle"]);
const NON_ENTITY_TARGET_KEYS = ["area_id", "device_id", "floor_id", "label_id"];
const TRANSLATION_PARAMS = ["language", "category", "integration", "config_flow"];
const DEFAULT_DASHBOARD = "lovelace";
export const LOCAL_SUBSCRIPTION = "local_subscription";
const SILENT_EVENT_TYPES = new Set([
  "service_registry_updated",
  "service_registered",
  "service_removed",
  "repairs_issue_registry_updated",
  "component_loaded",
  "user_updated",
  "entity_registry_updated",
  "area_registry_updated",
  "device_registry_updated",
  "floor_registry_updated",
  "label_registry_updated",
]);

function isObject(value: unknown): value is Message {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessageId(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function deny(id: number): InboundDecision {
  return {
    action: "reply",
    message: { id, type: "result", success: false, error: { code: "unauthorized", message: "Not allowed for guest sessions" } },
  };
}

function unknownCommand(id: number): InboundDecision {
  return {
    action: "reply",
    message: { id, type: "result", success: false, error: { code: "unknown_command", message: "Unknown command." } },
  };
}

function reply(id: number, result: unknown): ReplyDecision {
  return { action: "reply", message: { id, type: "result", success: true, result } };
}

function localSubscription(id: number, event?: Message): ReplyDecision {
  const decision: ReplyDecision = { ...reply(id, null), kind: LOCAL_SUBSCRIPTION };
  return event ? { ...decision, events: [{ id, type: "event", event }] } : decision;
}

function forward(message: Message): InboundDecision {
  return { action: "forward", message, kind: message.type as string };
}

function dashboardPath(urlPath: unknown): string | undefined {
  if (urlPath === null) return DEFAULT_DASHBOARD;
  return typeof urlPath === "string" ? urlPath : undefined;
}

const plain: InboundRule = (msg, id) => forward({ id, type: msg.type });

const INBOUND_RULES: Record<string, InboundRule> = {
  ping: plain,
  get_states: plain,
  get_config: plain,
  get_services: plain,
  get_panels: plain,
  "lovelace/resources": plain,
  "lovelace/dashboards/list": plain,
  "frontend/get_themes": plain,
  "frontend/get_icons": plain,
  "config/entity_registry/list_for_display": plain,
  "config/entity_registry/list": plain,

  "frontend/get_translations": (msg, id) => {
    const message: Message = { id, type: msg.type };
    for (const key of TRANSLATION_PARAMS) if (key in msg) message[key] = msg[key];
    return forward(message);
  },

  unsubscribe_events: (msg, id, _session, kindOf) => {
    if (!isMessageId(msg.subscription)) return deny(id);
    if (kindOf(msg.subscription) === LOCAL_SUBSCRIPTION) return reply(id, null);
    return forward({ id, type: msg.type, subscription: msg.subscription });
  },

  supported_features: (_msg, id) => reply(id, null),
  "auth/current_user": (_msg, id, { user }) =>
    reply(id, { id: user.id, name: user.name, is_owner: false, is_admin: false, credentials: [], mfa_modules: [] }),
  "frontend/get_user_data": (_msg, id) => reply(id, { value: null }),
  "frontend/subscribe_user_data": (_msg, id) => localSubscription(id, { value: null }),
  "config/area_registry/list": (_msg, id) => reply(id, []),
  "config/device_registry/list": (_msg, id) => reply(id, []),
  "config/floor_registry/list": (_msg, id) => reply(id, []),
  "config/label_registry/list": (_msg, id) => reply(id, []),

  subscribe_entities: (msg, id, { scope }) => forward({ id, type: msg.type, entity_ids: scope.entityIds() }),

  subscribe_events: (msg, id) => {
    if (typeof msg.event_type !== "string") return deny(id);
    if (SILENT_EVENT_TYPES.has(msg.event_type)) return localSubscription(id);
    if (Object.hasOwn(EVENT_FILTERS, msg.event_type)) return forward({ id, type: msg.type, event_type: msg.event_type });
    return deny(id);
  },

  "lovelace/config": (msg, id, { scope }) => {
    const path = dashboardPath(msg.url_path);
    if (path === undefined || !scope.canOpenDashboard(path)) return deny(id);
    const message: Message = { id, type: msg.type, url_path: msg.url_path };
    if (typeof msg.force === "boolean") message.force = msg.force;
    return forward(message);
  },

  call_service: (msg, id, { scope }) => {
    const { domain, service } = msg;
    if (typeof domain !== "string" || !NAME.test(domain)) return deny(id);
    if (typeof service !== "string" || !NAME.test(service)) return deny(id);
    if (msg.return_response !== undefined && msg.return_response !== false) return deny(id);

    const entityIds: string[] = [];
    const serviceData: Message = {};

    if (msg.target !== undefined) {
      if (!isObject(msg.target)) return deny(id);
      if (Object.keys(msg.target).some((key) => key !== "entity_id")) return deny(id);
      if (!collectEntityIds(msg.target.entity_id, entityIds)) return deny(id);
    }
    if (msg.service_data !== undefined) {
      if (!isObject(msg.service_data)) return deny(id);
      for (const [key, value] of Object.entries(msg.service_data)) {
        if (NON_ENTITY_TARGET_KEYS.includes(key)) return deny(id);
        if (key === "entity_id") {
          if (!collectEntityIds(value, entityIds)) return deny(id);
        } else {
          serviceData[key] = value;
        }
      }
    }

    if (entityIds.length === 0) return deny(id);
    for (const entityId of entityIds) {
      if (!scope.canControl(entityId)) return deny(id);
      const entityDomain = entityId.slice(0, entityId.indexOf("."));
      const crossDomain = domain === "homeassistant" && TOGGLE_SERVICES.has(service);
      if (entityDomain !== domain && !crossDomain) return deny(id);
    }

    return forward({
      id,
      type: "call_service",
      domain,
      service,
      target: { entity_id: [...new Set(entityIds)] },
      service_data: serviceData,
    });
  },
};

function collectEntityIds(value: unknown, into: string[]): boolean {
  if (value === undefined) return true;
  const list = Array.isArray(value) ? value : [value];
  for (const item of list) {
    if (!isEntityId(item)) return false;
    into.push(item);
  }
  return true;
}

export function inspectInbound(raw: unknown, session: Session, kindOf: KindOf): InboundDecision {
  if (!isObject(raw) || !isMessageId(raw.id) || typeof raw.type !== "string") return { action: "close" };
  const rule = Object.hasOwn(INBOUND_RULES, raw.type) ? INBOUND_RULES[raw.type] : undefined;
  return rule ? rule(raw, raw.id, session, kindOf) : unknownCommand(raw.id);
}

const identity: ResultFilter = (result) => result;

const RESULT_FILTERS: Record<string, ResultFilter> = {
  ping: identity,
  "lovelace/resources": identity,
  "frontend/get_themes": identity,
  "frontend/get_icons": identity,
  "frontend/get_translations": identity,
  unsubscribe_events: identity,
  subscribe_events: identity,
  subscribe_entities: identity,

  get_states: (result, { scope }) => (Array.isArray(result) ? result.filter((s) => isObject(s) && scope.canView(s.entity_id as string)) : []),
  get_config: (result) => redactConfig(result),
  get_services: (result, { scope }) => {
    if (!isObject(result)) return {};
    const domains = new Set(scope.entityIds().map((id) => id.slice(0, id.indexOf("."))));
    return Object.fromEntries(Object.entries(result).filter(([domain]) => domains.has(domain)));
  },
  get_panels: (result, { scope }) => {
    if (!isObject(result)) return {};
    return Object.fromEntries(
      Object.entries(result).filter(
        ([key, panel]) => isObject(panel) && panel.component_name === "lovelace" && panel.url_path === key && scope.canOpenDashboard(key),
      ),
    );
  },
  "lovelace/dashboards/list": (result, { scope }) =>
    Array.isArray(result) ? result.filter((d) => isObject(d) && scope.canOpenDashboard(d.url_path as string)) : [],
  "lovelace/config": (result, { scope, user }) => filterDashboard(result, scope, user.id),
  "config/entity_registry/list_for_display": (result, { scope }) => {
    if (!isObject(result)) return { entities: [] };
    const entities = Array.isArray(result.entities) ? result.entities.filter((e) => isObject(e) && scope.canView(e.ei as string)) : [];
    return { ...result, entities };
  },
  "config/entity_registry/list": (result, { scope }) =>
    Array.isArray(result) ? result.filter((e) => isObject(e) && scope.canView(e.entity_id as string)) : [],
  call_service: (result) => (isObject(result) ? { context: result.context } : result),
};

const EVENT_FILTERS: Record<string, EventFilter> = {
  state_changed: (data, scope) => (isObject(data) && scope.canView(data.entity_id as string) ? data : undefined),
  core_config_updated: (data) => redactConfig(data),
  lovelace_updated: (data, scope) => {
    const path = isObject(data) ? dashboardPath(data.url_path) : undefined;
    return path !== undefined && scope.canOpenDashboard(path) ? data : undefined;
  },
  panels_updated: (data) => data,
  themes_updated: (data) => data,
};

function filterEntityEvent(event: Message, scope: Scope): Message | null {
  const out: Message = {};
  for (const [key, value] of Object.entries(event)) {
    if (key === "a" || key === "c") {
      if (!isObject(value)) return null;
      const kept = Object.fromEntries(Object.entries(value).filter(([entityId]) => scope.canView(entityId)));
      if (Object.keys(kept).length > 0) out[key] = kept;
    } else if (key === "r") {
      if (!Array.isArray(value)) return null;
      const kept = value.filter((entityId) => scope.canView(entityId));
      if (kept.length > 0) out.r = kept;
    } else {
      return null;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function filterOutbound(raw: unknown, session: Session, kindOf: KindOf): Message | null {
  if (!isObject(raw) || !isMessageId(raw.id) || typeof raw.type !== "string") return null;
  const { id } = raw;
  const kind = kindOf(id);
  if (kind === undefined) return null;

  switch (raw.type) {
    case "pong":
      return kind === "ping" ? { id, type: "pong" } : null;

    case "result": {
      if (raw.success !== true) {
        const code = isObject(raw.error) && typeof raw.error.code === "string" ? raw.error.code : "unknown_error";
        return { id, type: "result", success: false, error: { code, message: "Request failed" } };
      }
      const filter = Object.hasOwn(RESULT_FILTERS, kind) ? RESULT_FILTERS[kind] : undefined;
      return filter ? { id, type: "result", success: true, result: filter(raw.result, session) } : null;
    }

    case "event": {
      if (!isObject(raw.event)) return null;
      if (kind === "subscribe_entities") {
        const event = filterEntityEvent(raw.event, session.scope);
        return event ? { id, type: "event", event } : null;
      }
      if (kind === "subscribe_events") {
        const eventType = raw.event.event_type;
        const filter = typeof eventType === "string" && Object.hasOwn(EVENT_FILTERS, eventType) ? EVENT_FILTERS[eventType] : undefined;
        if (!filter) return null;
        const data = filter(raw.event.data, session.scope);
        return data === undefined ? null : { id, type: "event", event: { ...raw.event, data } };
      }
      return null;
    }

    default:
      return null;
  }
}
