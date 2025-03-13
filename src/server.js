const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { db, initDatabase } = require('./db/init');
const pingService = require('./services/ping-service');
const config = require('../config.json');
const discoveryService = require('./services/discovery-service');

console.log('Starting application...');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Create metrics app if a separate metrics port is configured
const metricsApp = config.metricsPort ? express() : null;
const metricsServer = metricsApp ? http.createServer(metricsApp) : null;

let monitoringInterval;
let discoveryIntervals = [];
let isShuttingDown = false;

// Helper function to generate metrics text
async function generateMetrics() {
  const devices = await pingService.getAllDevices();
  let metrics = '# HELP device_online Device online status (1 = online, 0 = offline)\n';
  metrics += '# TYPE device_online gauge\n';
  
  // Add online/offline metrics for all devices
  for (const device of devices) {
    // Escape special characters in labels
    const name = device.name.replace(/"/g, '\\"');
    const section = device.section.replace(/"/g, '\\"');
    const type = device.type.replace(/"/g, '\\"');
    
    metrics += `device_online{name="${name}",ip="${device.ip}",section="${section}",type="${type}"} ${device.isAlive ? 1 : 0}\n`;
  }
  
  // Add latency metrics for ICMP devices
  metrics += '\n# HELP device_latency_ms Device ping latency in milliseconds\n';
  metrics += '# TYPE device_latency_ms gauge\n';
  
  for (const device of devices) {
    if (device.type === 'icmp' && device.time !== null) {
      const name = device.name.replace(/"/g, '\\"');
      const section = device.section.replace(/"/g, '\\"');
      
      metrics += `device_latency_ms{name="${name}",ip="${device.ip}",section="${section}"} ${device.time}\n`;
    }
  }
  
  // Add HTTP status code metrics
  metrics += '\n# HELP device_http_status_code HTTP status code from last check\n';
  metrics += '# TYPE device_http_status_code gauge\n';
  
  for (const device of devices) {
    if (device.type === 'http' && device.statusCode !== null) {
      const name = device.name.replace(/"/g, '\\"');
      const section = device.section.replace(/"/g, '\\"');
      
      metrics += `device_http_status_code{name="${name}",ip="${device.ip}",section="${section}"} ${device.statusCode}\n`;
    }
  }
  
  return metrics;
}

// Metrics endpoint handler
async function metricsHandler(req, res) {
  try {
    const metrics = await generateMetrics();
    res.set('Content-Type', 'text/plain');
    res.send(metrics);
  } catch (error) {
    console.error('Error generating metrics:', error);
    res.status(500).send('Error generating metrics');
  }
}

// Serve static files from the public directory
app.use(express.static('public'));

// Serve the main HTML page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Metrics endpoint for monitoring systems
app.get('/metrics', metricsHandler);

// If we have a separate metrics server, add the metrics endpoint to it as well
if (metricsApp) {
  metricsApp.get('/metrics', metricsHandler);
}

// WebSocket connection handling
io.on('connection', async (socket) => {
  console.log('Client connected');
  try {
    const [monitored, discovered] = await Promise.all([
      pingService.getAllDevices(),
      discoveryService.getDiscoveredDevices()
    ]);
    
    console.log(`Sending initial data: ${monitored.length} monitored devices, ${discovered.length} discovered devices`);
    socket.emit('initialData', { monitored, discovered });
  } catch (error) {
    console.error('Error fetching initial data:', error);
  }
  
  socket.on('disconnect', () => console.log('Client disconnected'));
});

// Start monitoring loop
async function startMonitoring() {
  console.log('Starting monitoring cycle...');
  try {
    for (const [section, devices] of Object.entries(config.monitors)) {
      for (const device of devices) {
        console.log(`Checking device: ${device.name} (${device.ip}) - Type: ${device.type}`);
        
        const status = await pingService.checkHost(
          device.ip,
          device.type,
          device.port,
          device.endpoint
        );
        
        await pingService.updateDeviceStatus(device.ip, status);
        
        io.emit('deviceUpdate', { 
          ...status, 
          name: device.name,
          section: section,
          type: device.type,
          port: device.port,
          endpoint: device.endpoint
        });
        
        console.log(`Device ${device.name} (${device.ip}) status:`, {
          alive: status.isAlive,
          type: device.type,
          time: status.time,
          ...(status.statusCode && { statusCode: status.statusCode }),
          ...(status.error && { error: status.error })
        });

        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  } catch (error) {
    console.error('Error in monitoring cycle:', error);
  }
}

async function cleanup() {
    if (isShuttingDown) {
        console.log('Cleanup already in progress...');
        return;
    }
    
    isShuttingDown = true;
    console.log('\nStarting cleanup...');

    try {
        // Stop discovery service
        discoveryService.stopScanning();
        console.log('Stopped discovery scanning');

        // Clear all intervals
        if (monitoringInterval) {
            clearInterval(monitoringInterval);
            console.log('Cleared monitoring interval');
        }

        discoveryIntervals.forEach((interval, index) => {
            clearInterval(interval);
            console.log(`Cleared discovery interval ${index + 1}`);
        });

        // Close socket connections first
        if (io) {
            await new Promise((resolve) => {
                try {
                    io.close(() => {
                        console.log('Socket connections closed');
                        resolve();
                    });
                } catch (err) {
                    console.log('Error closing socket connections:', err);
                    resolve();
                }
            });
        }

        // Close HTTP server
        await new Promise((resolve) => {
            try {
                server.close(() => {
                    console.log('HTTP server closed');
                    resolve();
                });
            } catch (err) {
                console.log('Error closing HTTP server:', err);
                resolve();
            }
        });
        
        // Close metrics server if running
        if (metricsServer) {
            await new Promise((resolve) => {
                try {
                    metricsServer.close(() => {
                        console.log('Metrics server closed');
                        resolve();
                    });
                } catch (err) {
                    console.log('Error closing metrics server:', err);
                    resolve();
                }
            });
        }

        // Close database connection last
        if (db) {
            await new Promise((resolve) => {
                try {
                    console.log('Closing database connection...');
                    db.close((err) => {
                        if (err) console.error('Error closing database:', err);
                        else console.log('Database connection closed');
                        resolve();
                    });
                } catch (err) {
                    console.log('Error during database closure:', err);
                    resolve();
                }
            });
        }

        console.log('Cleanup completed successfully');
        process.exit(0);
    } catch (error) {
        console.error('Error during cleanup:', error);
        process.exit(1);
    }
}

// Handle various shutdown signals
process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT signal');
    await cleanup();
});

process.on('SIGTERM', async () => {
    console.log('\nReceived SIGTERM signal');
    await cleanup();
});

process.on('uncaughtException', async (error) => {
    console.error('Uncaught Exception:', error);
    await cleanup();
});

process.on('unhandledRejection', async (error) => {
    console.error('Unhandled Rejection:', error);
    // Don't exit immediately for unhandled rejections
    // Just log them and continue
});

// Initialize and start server
async function start() {
    try {
        console.log('Initializing database...');
        await initDatabase();
        console.log('Database initialized successfully');

        // Start the server
        await new Promise((resolve) => {
            server.listen(config.webPort, () => {
                console.log(`Server running on http://localhost:${config.webPort}`);
                resolve();
            });
        });
        
        // Start the metrics server if configured
        if (metricsServer) {
            await new Promise((resolve) => {
                metricsServer.listen(config.metricsPort, () => {
                    console.log(`Metrics server running on http://localhost:${config.metricsPort}/metrics`);
                    resolve();
                });
            });
        }

        // Start the initial monitoring cycle
        console.log('Starting initial monitoring cycle...');
        await startMonitoring();

        // Set up the monitoring interval
        console.log(`Setting up monitoring interval (${config.checkInterval} seconds)`);
        monitoringInterval = setInterval(startMonitoring, config.checkInterval * 1000);

        // Set up network scanning
        if (config.networks && config.networks.length > 0) {
            for (const network of config.networks) {
                console.log(`Setting up network discovery for ${network.subnet}`);
                // Run initial scan
                discoveryService.scanNetwork(network.subnet, io);
                
                const interval = setInterval(() => {
                    discoveryService.scanNetwork(network.subnet, io);
                }, (network.scanInterval || 300) * 1000);
                
                discoveryIntervals.push(interval);
                console.log(`Set up discovery interval for ${network.subnet}`);
            }
        }

    } catch (error) {
        console.error('Error starting application:', error);
        await cleanup();
    }
}

// Start the application
console.log('Configuration loaded:', config);
start().catch(async error => {
    console.error('Fatal error:', error);
    await cleanup();
}); 