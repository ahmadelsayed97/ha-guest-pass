export function isLanAddress(address: string | null | undefined): address is string {
  if (!address) return false;
  let ip = address.trim().toLowerCase();
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  if (ip.startsWith("::ffff:")) {
    const v4 = ip.slice(7);
    if (v4.includes(".")) return isLanIPv4(v4);
    return false;
  }
  if (ip.includes(":")) return isLanIPv6(ip);
  return isLanIPv4(ip);
}

function parseIPv4(ip: string): [number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return [octets[0]!, octets[1]!];
}

function isLanIPv4(ip: string): boolean {
  const octets = parseIPv4(ip);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isLanIPv6(ip: string): boolean {
  if (ip === "::1") return true;
  const first = ip.split(":")[0] ?? "";
  if (!/^[0-9a-f]{1,4}$/.test(first)) return false;
  const hextet = parseInt(first, 16);
  if ((hextet & 0xfe00) === 0xfc00) return true;
  if ((hextet & 0xffc0) === 0xfe80) return true;
  return false;
}
