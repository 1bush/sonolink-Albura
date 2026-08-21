/**
 * NetworkScanner.ts
 *
 * Scans the local network to find the SonoScape P50 Elite device.
 * Used as a fallback when the IP address in the QR code is unreachable
 * (e.g. if the device's IP changed via DHCP but the QR wasn't refreshed).
 */
import TcpSocket from 'react-native-tcp-socket';
import * as Network from 'expo-network';

/**
 * Scans a given subnet (e.g. "192.168.1") starting at the requested first host
 * (default 1) and returning the first IP on `port` that accepts a TCP
 * connection. Also accepts an optional IP to exclude (e.g. this phone itself).
 */
function scanSubnet(
  subnet: string,
  port: number,
  {
    firstHost = 1,
    lastHost = 254,
    exclude = '',
    timeout = 600,
  }: { firstHost?: number; lastHost?: number; exclude?: string; timeout?: number } = {},
): Promise<string | null> {
  const scanTasks = Array.from({ length: lastHost - firstHost + 1 }, (_, i) => firstHost + i).map(
    async (host) => {
      const targetIP = `${subnet}.${host}`;
      if (targetIP === exclude) return null;

      return new Promise<string | null>((resolve) => {
        const socket = TcpSocket.createConnection({ host: targetIP, port, tls: false }, () => {
          socket.destroy();
          resolve(targetIP);
        });

        socket.on('error', () => {
          socket.destroy();
          resolve(null);
        });

        setTimeout(() => {
          socket.destroy();
          resolve(null);
        }, timeout);
      });
    },
  );

  return Promise.all(scanTasks).then((results) => results.find((ip) => ip !== null) || null);
}

export async function findDeviceIP(port: number): Promise<string | null> {
  const localIP = await Network.getIpAddressAsync();

  // 1) Always try the 192.168.1.x subnet first (the SonoScape P50 Elite defaults
  //    to this on its access point / LAN), starting at host 1.
  const p50Subnet = '192.168.1';
  const p50Hit = await scanSubnet(p50Subnet, port, { exclude: localIP ?? '' });
  if (p50Hit) return p50Hit;

  // 2) Fall back to whatever subnet this phone is actually on.
  if (localIP && localIP !== '0.0.0.0') {
    const subnet = localIP.split('.').slice(0, 3).join('.');
    const hit = await scanSubnet(subnet, port, { exclude: localIP });
    if (hit) return hit;
  }

  return null;
}
