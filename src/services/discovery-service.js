const { networkInterfaces } = require('os');
const ping = require('ping');
const { db } = require('../db/init');
const { promisify } = require('util');
const dns = require('dns');
const { exec } = require('child_process');
const execAsync = promisify(exec);

class DiscoveryService {
    constructor() {
        this.scanning = false;
        this.shouldStop = false;
        this.monitoredIPs = new Set();
        this.debug = process.env.DEBUG === 'true';
    }

    log(...args) {
        if (this.debug) {
            console.log(...args);
        }
    }

    error(...args) {
        // Always log errors, but prefix them
        console.error('[ERROR]', ...args);
    }

    async loadMonitoredIPs() {
        return new Promise((resolve, reject) => {
            db.all('SELECT ip FROM monitored_devices', [], (err, rows) => {
                if (err) {
                    this.error('Error loading monitored IPs:', err);
                    reject(err);
                } else {
                    this.monitoredIPs = new Set(rows.map(row => row.ip));
                    this.log('Loaded monitored IPs:', Array.from(this.monitoredIPs));
                    resolve();
                }
            });
        });
    }

    stopScanning() {
        this.shouldStop = true;
    }

    async scanNetwork(subnet, io) {
        if (this.scanning || this.shouldStop) {
            this.log('Scan already in progress or stop requested');
            return;
        }
        
        await this.loadMonitoredIPs();
        
        this.scanning = true;
        this.log(`\n=== Starting network scan for subnet: ${subnet} ===`);

        try {
            const baseIP = subnet.split('/')[0];
            const ipBase = baseIP.split('.').slice(0, 3).join('.');
            this.log(`Base IP: ${ipBase}`);
            
            for (let i = 1; i < 255; i++) {
                if (this.shouldStop) {
                    this.log('Stopping network scan due to shutdown request');
                    break;
                }
                
                const ip = `${ipBase}.${i}`;
                
                if (this.monitoredIPs.has(ip)) {
                    this.log(`Skipping monitored IP: ${ip}`);
                    continue;
                }

                this.log(`Scanning IP: ${ip}`);
                
                const result = await ping.promise.probe(ip, {
                    timeout: 1,
                    min_reply: 1
                });

                if (result.alive) {
                    this.log(`\n🟢 New device found: ${ip}`);
                    const device = await this.updateDiscoveredDevice(ip);
                    if (io) {
                        this.log(`Emitting discovered device: ${ip}`);
                        io.emit('discoveredDevice', device);
                    }
                } else {
                    this.log(`⚫ No response from ${ip}`);
                }
            }
            
            this.log(`\n=== Network scan completed for ${subnet} ===\n`);
        } catch (error) {
            this.error('Error during network scan:', error);
        } finally {
            this.scanning = false;
        }
    }

    async getHostname(ip) {
        try {
            const result = await dns.promises.reverse(ip);
            return result[0] || null;
        } catch (error) {
            this.log(`No hostname found for ${ip}`);
            return null;
        }
    }

    async getMacAddress(ip) {
        try {
            // Run arp-scan for the local network and grep for the specific IP
            const { stdout } = await execAsync(`sudo arp-scan --localnet --numeric --quiet | grep ${ip}`);
            const lines = stdout.split('\n');
            for (const line of lines) {
                if (line.includes(ip)) {
                    const parts = line.split('\t');
                    if (parts.length >= 2) {
                        return parts[1].trim();
                    }
                }
            }
            return null;
        } catch (error) {
            this.log(`Could not get MAC address for ${ip}: ${error.message}`);
            return null;
        }
    }

    async updateDiscoveredDevice(ip) {
        const hostname = await this.getHostname(ip);
        const mac = await this.getMacAddress(ip);
        
        return new Promise((resolve, reject) => {
            // First check if this IP is monitored
            if (this.monitoredIPs.has(ip)) {
                reject(new Error(`IP ${ip} is already monitored`));
                return;
            }

            this.log(`Updating discovered device in database: ${ip}`);
            
            // Check for existing discovered device
            db.get('SELECT * FROM discovered_devices WHERE ip = ?', [ip], (err, row) => {
                if (err) {
                    this.error(`Error checking existing device ${ip}:`, err);
                    reject(err);
                    return;
                }

                if (row) {
                    // Update existing device
                    const query = `
                        UPDATE discovered_devices 
                        SET last_seen = CURRENT_TIMESTAMP,
                            total_uptime = total_uptime + 1,
                            hostname = ?,
                            mac = ?
                        WHERE ip = ?
                    `;
                    
                    db.run(query, [hostname, mac, ip], (function(err) {
                        if (err) {
                            this.error(`Error updating discovered device ${ip}:`, err);
                            reject(err);
                        } else {
                            this.log(`Updated existing device ${ip}`);
                            resolve({
                                ...row,
                                hostname,
                                mac,
                                last_seen: new Date().toISOString(),
                                isAlive: true
                            });
                        }
                    }).bind(this));
                } else {
                    // Insert new device
                    const query = `
                        INSERT INTO discovered_devices (ip, hostname, mac, first_seen, last_seen, total_uptime)
                        VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)
                    `;
                    
                    db.run(query, [ip, hostname, mac], (function(err) {
                        if (err) {
                            this.error(`Error inserting discovered device ${ip}:`, err);
                            reject(err);
                        } else {
                            this.log(`Inserted new device ${ip}`);
                            resolve({
                                ip,
                                hostname,
                                mac,
                                first_seen: new Date().toISOString(),
                                last_seen: new Date().toISOString(),
                                total_uptime: 1,
                                isAlive: true,
                                id: this.lastID
                            });
                        }
                    }).bind(this));
                }
            });
        });
    }

    async getDiscoveredDevices() {
        // Reload monitored IPs to ensure list is current
        await this.loadMonitoredIPs();

        return new Promise((resolve, reject) => {
            this.log('Fetching all discovered devices...');
            db.all(`
                SELECT * FROM discovered_devices 
                WHERE ip NOT IN (SELECT ip FROM monitored_devices)
                ORDER BY last_seen DESC
            `, (err, rows) => {
                if (err) {
                    this.error('Error fetching discovered devices:', err);
                    reject(err);
                } else {
                    this.log(`Found ${rows.length} discovered devices`);
                    resolve(rows.map(row => ({
                        ...row,
                        isAlive: true
                    })));
                }
            });
        });
    }
}

module.exports = new DiscoveryService(); 