// Debug mode only: nginx sends its error log here as syslog messages over
// UDP on 127.0.0.1, and each line is written to the container log with
// tokens removed. (Errors for proxied Plex requests quote the request line,
// and Plex requests carry the token in the query string.)
import { createSocket } from 'node:dgram';
import { log } from './log.js';

export function cleanSyslogLine(text) {
  return String(text)
    .replace(/^<\d{1,3}>/, '') // priority
    .replace(/^[A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d /, '') // syslog timestamp
    .replace(/^(?:\S+ )?nginx: /, '') // optional hostname, then the tag
    .replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d /, ''); // nginx's own timestamp
}

export function listenForNginx(port) {
  const sock = createSocket('udp4');
  sock.on('message', (buf) => log.nginx(cleanSyslogLine(buf.toString('utf8'))));
  sock.on('error', (err) => {
    log.warn(`couldn't listen for nginx's error log on 127.0.0.1:${port} (${err.code || err.message}); nginx errors won't be shown`);
    sock.close();
  });
  sock.bind(port, '127.0.0.1');
  sock.unref();
  return sock;
}
