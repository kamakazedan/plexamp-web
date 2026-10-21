// What the service goes by in a request: its path, and where it came from.

// Request paths the service answers: plain ones only.
//
// nginx decides what reaches the service by the path it sees, and a URL
// parser reads some paths differently ("\" as "/", "." and ".." dropped,
// %2F as a letter rather than a "/"), so a path nginx didn't take for
// /api/ai/, say, could become one here. A path that isn't plain is answered
// as if it weren't there.
export const plainPath = (raw) =>
  typeof raw === 'string' && /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(raw) && !/\/\/|\/\.\.?(\/|$)|%(2e|2f|5c)/i.test(raw);

// The address a request came from, as nginx saw it (behind another proxy,
// that proxy's), for limits: an IPv6 address by its /64, as one network can
// have any number of addresses in it.
export function clientIp(req) {
  const ip = String(req.headers['x-real-ip'] || 'local').slice(0, 64).toLowerCase();
  if (!ip.includes(':')) return ip;
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (v4) return v4[1];
  const [head, tail = ''] = ip.split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
