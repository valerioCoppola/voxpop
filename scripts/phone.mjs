// Serve the built app to phones on the same Wi-Fi, over HTTPS.
//
// Phones only allow the camera on https:// pages, so this uses a temporary
// self-signed certificate made on this computer. The phone will warn that the
// certificate is not trusted: that is expected for a local test. Nothing goes
// through the internet; the phone talks straight to this computer.
//
//   npm run phone            (builds first, then serves on port 4443)
//   PORT=5000 npm run phone

import { networkInterfaces } from 'node:os';
import { preview } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import QRCode from 'qrcode';

const port = Number(process.env.PORT || 4443);

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^(docker|br-|veth|virbr|lxc|tun|tap|wg)/.test(name)) continue; // skip virtual interfaces
      out.push({ name, address: a.address });
    }
  }
  // Typical home networks first.
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3);
  return out.sort((a, b) => rank(a.address) - rank(b.address));
}

const server = await preview({
  plugins: [basicSsl({ name: 'voxpop-local-test' })],
  preview: { host: '0.0.0.0', port, strictPort: true, open: false },
});

const ips = lanAddresses();
console.log('\n  VoxPop is being served to your local network over HTTPS.\n');
if (!ips.length) {
  console.log('  No Wi-Fi/Ethernet address found. Is this computer connected to a network?\n');
} else {
  const url = `https://${ips[0].address}:${port}/`;
  console.log(`  On the phone (same Wi-Fi), open:  ${url}\n`);
  console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
  if (ips.length > 1) {
    console.log('  Other addresses of this computer, if the first does not work:');
    for (const ip of ips.slice(1)) console.log(`    https://${ip.address}:${port}/   (${ip.name})`);
    console.log();
  }
}
console.log('  The phone will say the connection is not private. That is the local test certificate:');
console.log('    Android Chrome: Advanced → Proceed.   iPhone Safari: Show Details → visit this website.');
console.log('  Then tap "Start camera" and allow camera and microphone.\n');
console.log('  Press Ctrl+C to stop.\n');

process.on('SIGINT', async () => {
  await server.close();
  process.exit(0);
});
