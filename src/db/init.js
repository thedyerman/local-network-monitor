const sqlite3 = require('sqlite3').verbose();
const path = require('path');

console.log('Creating database connection...');
const dbPath = path.join(__dirname, '../../data.db');
console.log('Database path:', dbPath);

const db = new sqlite3.Database(dbPath);

const initDatabase = () => {
    return new Promise((resolve, reject) => {
        console.log('Starting database initialization...');
        db.serialize(() => {
            try {
                // Drop existing tables for clean start (remove this in production)
                // db.run('DROP TABLE IF EXISTS monitored_devices');
                // db.run('DROP TABLE IF EXISTS discovered_devices');

                // Table for monitored devices
                db.run(`
                    CREATE TABLE IF NOT EXISTS monitored_devices (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        ip TEXT NOT NULL,
                        name TEXT,
                        type TEXT NOT NULL,
                        section TEXT NOT NULL,
                        port INTEGER,
                        endpoint TEXT,
                        last_check DATETIME,
                        last_status BOOLEAN,
                        last_response_time INTEGER,
                        last_status_code INTEGER,
                        last_error TEXT,
                        uptime INTEGER DEFAULT 0
                    )
                `, (err) => {
                    if (err) {
                        console.error('Error creating monitored_devices table:', err);
                        reject(err);
                        return;
                    }
                    console.log('monitored_devices table ready');
                });

                // Table for discovered devices
                db.run(`
                    CREATE TABLE IF NOT EXISTS discovered_devices (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        ip TEXT NOT NULL UNIQUE,
                        hostname TEXT,
                        mac TEXT,
                        first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
                        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
                        total_uptime INTEGER DEFAULT 0
                    )
                `, (err) => {
                    if (err) {
                        console.error('Error creating discovered_devices table:', err);
                        reject(err);
                        return;
                    }
                    console.log('discovered_devices table ready');
                });

                // Initialize monitored devices from config
                const config = require('../../config.json');
                const stmt = db.prepare(`
                    INSERT OR REPLACE INTO monitored_devices (ip, name, type, section, port, endpoint)
                    VALUES (?, ?, ?, ?, ?, ?)
                `);

                // Handle the new nested structure
                Object.entries(config.monitors).forEach(([section, devices]) => {
                    devices.forEach(device => {
                        stmt.run(
                            device.ip, 
                            device.name, 
                            device.type, 
                            section,
                            device.port || null,
                            device.endpoint || '/',
                            (err) => {
                                if (err) {
                                    console.error(`Error inserting device ${device.ip}:`, err);
                                } else {
                                    console.log(`Device ${device.ip} initialized in database`);
                                }
                            }
                        );
                    });
                });

                stmt.finalize((err) => {
                    if (err) {
                        console.error('Error finalizing statement:', err);
                        reject(err);
                    } else {
                        console.log('Database initialization completed');
                        resolve();
                    }
                });
            } catch (error) {
                console.error('Error during database initialization:', error);
                reject(error);
            }
        });
    });
};

// Handle database errors
db.on('error', (err) => {
    console.error('Database error:', err);
});

module.exports = { db, initDatabase }; 