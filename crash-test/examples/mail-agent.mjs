// An agent that sends a customer email over SMTP, with no checkpoint. SMTP_KEYED=1 sets a stable X-Idempotency-Key header on the message.
import net from 'node:net'

const host = process.env.CRASHTEST_SMTP_HOST
const port = Number(process.env.CRASHTEST_SMTP_PORT)
if (!host || !port) throw new Error('Run me under crash-test: it sets CRASHTEST_SMTP_HOST and CRASHTEST_SMTP_PORT.')

function send({ to, subject, body, key }) {
  return new Promise((ok, bad) => {
    const sock = net.connect(port, host)
    sock.setEncoding('utf8')
    const lines = [
      null, // greeting
      'EHLO agent',
      'MAIL FROM:<support@example.com>',
      `RCPT TO:<${to}>`,
      'DATA',
      [`From: support@example.com`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${Math.random().toString(36).slice(2)}@example.com>`, ...(key ? [`X-Idempotency-Key: ${key}`] : []), '', body, '.'].join('\r\n'),
      'QUIT',
    ]
    let step = 0
    let buf = ''
    sock.on('error', bad)
    sock.on('close', () => (step >= lines.length ? ok() : bad(new Error('connection closed before QUIT'))))
    sock.on('data', (d) => {
      buf += d
      while (buf.includes('\r\n')) {
        const line = buf.slice(0, buf.indexOf('\r\n'))
        buf = buf.slice(buf.indexOf('\r\n') + 2)
        if (/^\d{3}-/.test(line)) continue
        if (/^[45]/.test(line)) return bad(new Error(line))
        if (++step < lines.length) sock.write(lines[step] + '\r\n')
      }
    })
  })
}

await send({ to: 'dana@example.com', subject: 'Your refund', body: 'Your refund is on its way.', key: process.env.SMTP_KEYED ? 'ticket-T-77:email' : null })
console.log('sent')
await send({ to: 'dana@example.com', subject: 'Ticket closed', body: 'We closed ticket T-77.', key: process.env.SMTP_KEYED ? 'ticket-T-77:close-email' : null })
console.log('sent')
