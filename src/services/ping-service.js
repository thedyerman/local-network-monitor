const ping = require('ping');
const { db } = require('../db/init');
const http = require('http');

class PingService {
  constructor() {
    this.debug = process.env.DEBUG === 'true';
  }

  log(...args) {
    if (this.debug) {
      console.log(...args);
    }
  }

  error(...args) {
    console.error('[ERROR]', ...args);
  }

  async checkHost(ip, type = 'icmp', port = null, endpoint = '/') {
    this.log(`Checking ${ip} using ${type.toUpperCase()}...`);
    
    try {
      if (type === 'http') {
        return await this.checkHttp(ip, port, endpoint);
      } else {
        return await this.checkIcmp(ip);
      }
    } catch (error) {
      this.error(`Error checking ${ip}:`, error);
      return {
        ip,
        isAlive: false,
        error: error.message,
        timestamp: new Date()
      };
    }
  }

  async checkHttp(ip, port, endpoint) {
    this.log(`HTTP check for http://${ip}:${port}${endpoint}`);
    
    return new Promise((resolve) => {
      const request = http.get(`http://${ip}:${port}${endpoint}`, {
        timeout: 5000, // 5 second timeout
      }, (response) => {
        this.log(`HTTP Response from ${ip}:${port}: Status ${response.statusCode}`);
        
        // Consider any 2xx status code as success
        const isSuccess = response.statusCode >= 200 && response.statusCode < 300;
        
        resolve({
          ip,
          isAlive: isSuccess,
          time: null, // We could implement response time measurement if needed
          timestamp: new Date(),
          statusCode: response.statusCode
        });
      });

      request.on('error', (error) => {
        this.error(`HTTP Error for ${ip}:${port}:`, error.message);
        resolve({
          ip,
          isAlive: false,
          error: error.message,
          timestamp: new Date()
        });
      });

      request.on('timeout', () => {
        this.error(`HTTP Timeout for ${ip}:${port}`);
        request.destroy();
        resolve({
          ip,
          isAlive: false,
          error: 'Timeout',
          timestamp: new Date()
        });
      });
    });
  }

  async checkIcmp(ip) {
    this.log(`ICMP check for ${ip}...`);
    const result = await ping.promise.probe(ip);
    this.log(`ICMP result for ${ip}:`, result.alive);
    return {
      ip,
      isAlive: result.alive,
      time: result.time,
      timestamp: new Date()
    };
  }

  async updateDeviceStatus(ip, status) {
    return new Promise((resolve, reject) => {
      this.log(`Updating status for ${ip}:`, status);
      const query = `
        UPDATE monitored_devices 
        SET last_check = CURRENT_TIMESTAMP,
            last_status = ?,
            last_response_time = ?,
            last_status_code = ?,
            last_error = ?,
            uptime = CASE WHEN ? = 1 
                          THEN uptime + 1 
                          ELSE uptime 
                     END
        WHERE ip = ?
      `;
      
      db.run(query, [
        status.isAlive ? 1 : 0,
        status.time || null,
        status.statusCode || null,
        status.error || null,
        status.isAlive ? 1 : 0,
        ip
      ], (err) => {
        if (err) {
          this.error(`Error updating device status for ${ip}:`, err);
          reject(err);
        } else {
          this.log(`Status updated for ${ip}`);
          resolve();
        }
      });
    });
  }

  async getAllDevices() {
    return new Promise((resolve, reject) => {
      this.log('Fetching all devices with their last known status...');
      db.all(`
        SELECT 
          md.*,
          last_status as isAlive,
          last_response_time as time,
          last_status_code as statusCode,
          last_error as error,
          last_check as timestamp,
          type,
          port,
          endpoint
        FROM monitored_devices md
        ORDER BY section, name
      `, (err, rows) => {
        if (err) {
          this.error('Error fetching devices:', err);
          reject(err);
        } else {
          this.log(`Found ${rows.length} devices with status:`, rows);
          resolve(rows.map(row => ({
            ...row,
            isAlive: Boolean(row.last_status),
            time: row.last_response_time,
            statusCode: row.last_status_code,
            error: row.last_error,
            timestamp: row.last_check
          })));
        }
      });
    });
  }
}

module.exports = new PingService(); 