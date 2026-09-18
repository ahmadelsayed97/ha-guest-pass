export type Logger = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;

export const consoleLogger: Logger = (level, msg, fields) => {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}${fields ? " " + JSON.stringify(fields) : ""}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

export const silentLogger: Logger = () => {};
