const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const puppeteer = require('puppeteer');
const { Expo } = require('expo-server-sdk');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || '/data/data.json';

app.use(cors());
app.use(express.json());

// Expo push notifications
const expo = new Expo();

// In-memory storage for demo (replace with persistent DB in production)
let users = [];
let logs = [];
let lastCheck = null;
let availableCourts = [];

// Load data on startup
loadData();

async function loadData() {
  try {
    const data = await fs.readFile(DB_PATH, 'utf8');
    const parsed = JSON.parse(data);
    users = parsed.users || [];
    logs = parsed.logs || [];
    lastCheck = parsed.lastCheck;
    availableCourts = parsed.availableCourts || [];
    console.log('Data loaded from', DB_PATH);
  } catch (error) {
    console.log('No existing data file, starting fresh');
  }
}

async function saveData() {
  try {
    await fs.writeFile(DB_PATH, JSON.stringify({
      users,
      logs,
      lastCheck,
      availableCourts
    }, null, 2));
  } catch (error) {
    console.error('Failed to save data:', error);
  }
}

function addLog(message, type = 'info') {
  const log = {
    id: Date.now(),
    timestamp: new Date().toISOString(),
    message,
    type
  };
  logs.unshift(log);
  // Keep only last 100 logs
  if (logs.length > 100) {
    logs = logs.slice(0, 100);
  }
  console.log(`[${type.toUpperCase()}] ${message}`);
  saveData();
}

async function scrapeTennisCourts() {
  let browser;
  try {
    addLog('Starting court availability check...');
    
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    
    addLog('Navigating to Joe DiMaggio tennis courts page...');
    await page.goto('https://rec.us/joedimaggio', { waitUntil: 'networkidle2' });
    
    // Wait for page to load
    await page.waitForTimeout(3000);
    
    // Look for tennis court availability
    const courts = await page.evaluate(() => {
      const found = [];
      
      // Look for date elements and tennis-related content
      const dateElements = document.querySelectorAll('[data-date], .date, .day');
      const tennisElements = document.querySelectorAll('*');
      
      // Get current date and upcoming Fridays
      const now = new Date();
      const upcomingFridays = [];
      for (let i = 0; i < 14; i++) {
        const date = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
        if (date.getDay() === 5) { // Friday
          upcomingFridays.push(date.toISOString().split('T')[0]);
        }
      }
      
      // Search for tennis courts and availability
      tennisElements.forEach(el => {
        const text = el.textContent?.toLowerCase() || '';
        if (text.includes('tennis') || text.includes('court')) {
          const parent = el.closest('[data-date], .booking-slot, .time-slot, .facility');
          if (parent) {
            const dateAttr = parent.getAttribute('data-date') || parent.textContent;
            found.push({
              text: el.textContent?.trim() || '',
              date: dateAttr,
              available: !text.includes('booked') && !text.includes('unavailable')
            });
          }
        }
      });
      
      return found;
    });
    
    addLog(`Found ${courts.length} court-related elements`);
    
    // Filter for Fridays and available courts
    const fridayCourts = courts.filter(court => {
      const courtText = court.text.toLowerCase();
      return court.available && (courtText.includes('friday') || courtText.includes('fri'));
    });
    
    addLog(`Filtered to ${fridayCourts.length} potentially available Friday courts`);
    
    // Update available courts
    const newAvailable = fridayCourts.map(court => ({
      id: `${Date.now()}-${Math.random()}`,
      facility: 'Joe DiMaggio Tennis Courts',
      date: court.date,
      description: court.text,
      timestamp: new Date().toISOString()
    }));
    
    // Check if there are new available courts
    const hasNewCourts = newAvailable.length > 0 && (
      availableCourts.length === 0 || 
      newAvailable.some(newCourt => 
        !availableCourts.some(existing => existing.description === newCourt.description)
      )
    );
    
    availableCourts = newAvailable;
    lastCheck = new Date().toISOString();
    
    if (hasNewCourts && availableCourts.length > 0) {
      addLog(`Found ${availableCourts.length} available courts! Sending notifications...`, 'success');
      await sendNotifications(availableCourts);
    } else if (availableCourts.length === 0) {
      addLog('No available courts found for upcoming Fridays');
    } else {
      addLog('No new courts available (same as last check)');
    }
    
    await saveData();
    
  } catch (error) {
    addLog(`Error scraping courts: ${error.message}`, 'error');
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function sendNotifications(courts) {
  if (users.length === 0) {
    addLog('No users registered for notifications');
    return;
  }
  
  const messages = [];
  
  for (const user of users) {
    if (!Expo.isExpoPushToken(user.pushToken)) {
      addLog(`Invalid push token for user: ${user.pushToken}`, 'error');
      continue;
    }
    
    messages.push({
      to: user.pushToken,
      sound: 'default',
      title: 'Tennis Courts Available! 🎾',
      body: `Found ${courts.length} available court${courts.length > 1 ? 's' : ''} at Joe DiMaggio for upcoming Fridays`,
      data: { courts }
    });
  }
  
  if (messages.length === 0) {
    addLog('No valid push tokens to send notifications to');
    return;
  }
  
  try {
    const chunks = expo.chunkPushNotifications(messages);
    
    for (const chunk of chunks) {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      addLog(`Sent ${chunk.length} notifications`);
    }
  } catch (error) {
    addLog(`Error sending notifications: ${error.message}`, 'error');
  }
}

// Routes
app.get('/', (req, res) => {
  console.log(`${req.method} ${req.url} - 200`);
  res.json({ 
    status: 'Tennis Court Monitor API Running',
    lastCheck,
    availableCourts: availableCourts.length,
    registeredUsers: users.length
  });
});

app.post('/register-token', (req, res) => {
  console.log(`${req.method} ${req.url} - 200`);
  const { pushToken } = req.body;
  
  if (!pushToken) {
    return res.status(400).json({ error: 'Push token required' });
  }
  
  if (!Expo.isExpoPushToken(pushToken)) {
    return res.status(400).json({ error: 'Invalid push token format' });
  }
  
  const existingUser = users.find(u => u.pushToken === pushToken);
  if (!existingUser) {
    users.push({ pushToken, registeredAt: new Date().toISOString() });
    addLog(`New user registered: ${pushToken}`);
    saveData();
  }
  
  res.json({ success: true, message: 'Push token registered' });
});

app.post('/test-notification', async (req, res) => {
  console.log(`${req.method} ${req.url} - 200`);
  const { pushToken } = req.body;
  
  if (!pushToken || !Expo.isExpoPushToken(pushToken)) {
    return res.status(400).json({ error: 'Valid push token required' });
  }
  
  try {
    await expo.sendPushNotificationsAsync([{
      to: pushToken,
      sound: 'default',
      title: 'Test Notification 🎾',
      body: 'Your tennis court notifications are working!',
      data: { test: true }
    }]);
    
    addLog(`Test notification sent to ${pushToken}`);
    res.json({ success: true, message: 'Test notification sent' });
  } catch (error) {
    addLog(`Error sending test notification: ${error.message}`, 'error');
    res.status(500).json({ error: 'Failed to send test notification' });
  }
});

app.get('/status', (req, res) => {
  console.log(`${req.method} ${req.url} - 200`);
  res.json({
    lastCheck,
    availableCourts,
    totalUsers: users.length,
    recentLogs: logs.slice(0, 10)
  });
});

app.get('/logs', (req, res) => {
  console.log(`${req.method} ${req.url} - 200`);
  res.json({ logs });
});

app.post('/check-now', async (req, res) => {
  console.log(`${req.method} ${req.url} - 200`);
  addLog('Manual court check requested');
  
  // Run check asynchronously
  scrapeTennisCourts();
  
  res.json({ success: true, message: 'Court check started' });
});

// Schedule court checking every 30 minutes
cron.schedule('*/30 * * * *', () => {
  addLog('Scheduled court check triggered');
  scrapeTennisCourts();
});

// Initial check on startup
setTimeout(() => {
  addLog('Starting initial court check...');
  scrapeTennisCourts();
}, 5000);

app.listen(PORT, () => {
  console.log(`Tennis Court Monitor API running on port ${PORT}`);
  addLog(`Server started on port ${PORT}`);
});