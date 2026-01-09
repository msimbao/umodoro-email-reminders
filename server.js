// server.js
const express = require('express');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});

const db = admin.firestore();

// Configure email transporter (using Gmail as example)
// You can also use SendGrid, Resend, or other services
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD, // Use App Password for Gmail
  },
});

// Helper function to check if reminder should be sent today
function shouldSendToday(days) {
  const dayMap = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };
  
  const today = new Date().getDay();
  return days.some(day => dayMap[day.toLowerCase()] === today);
}

// Helper function to check if it's time to send (within the current hour)
function isTimeToSend(reminderTime) {
  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  
  // Parse reminder time (format: "HH:MM")
  const [reminderHour, reminderMinute] = reminderTime.split(':').map(Number);
  
  // Send if we're in the same hour and haven't passed 15 minutes after
  return currentHour === reminderHour && currentMinute <= 15;
}

// Helper function to check if reminder was already sent today
function wasSentToday(lastSent) {
  if (!lastSent) return false;
  
  const lastSentDate = new Date(lastSent);
  const today = new Date();
  
  return (
    lastSentDate.getDate() === today.getDate() &&
    lastSentDate.getMonth() === today.getMonth() &&
    lastSentDate.getFullYear() === today.getFullYear()
  );
}

// Function to send reminder email
async function sendReminderEmail(userEmail, userName, reminderTime) {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: userEmail,
    subject: '📚 Study Reminder - Time to Learn!',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #4F46E5;">Time for Your Study Session! 📖</h2>
        <p>Hi ${userName || 'Student'},</p>
        <p>This is your scheduled study reminder for <strong>${reminderTime}</strong>.</p>
        <p>Remember: Consistency is key to mastering any subject. Even 15 minutes of focused study can make a big difference!</p>
        <div style="background-color: #F3F4F6; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="margin-top: 0; color: #1F2937;">Quick Study Tips:</h3>
          <ul style="color: #4B5563;">
            <li>Find a quiet, distraction-free environment</li>
            <li>Review your notes from the last session</li>
            <li>Set a clear goal for this study session</li>
            <li>Take short breaks every 25-30 minutes</li>
          </ul>
        </div>
        <p>Ready to continue your learning journey? Let's make today count!</p>
        <p style="margin-top: 30px; color: #6B7280; font-size: 14px;">
          You're receiving this because you set up study reminders. You can manage your reminders in the app settings.
        </p>
      </div>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`✅ Reminder email sent to ${userEmail}`);
    return true;
  } catch (error) {
    console.error(`❌ Error sending email to ${userEmail}:`, error);
    return false;
  }
}

// Main function to process reminders
async function processReminders() {
  console.log('🔄 Starting reminder processing...');
  
  try {
    // Get all enabled reminders
    const remindersSnapshot = await db
      .collection('reminders')
      .where('enabled', '==', true)
      .get();

    console.log(`📋 Found ${remindersSnapshot.size} enabled reminders`);

    let processedCount = 0;
    let sentCount = 0;

    for (const reminderDoc of remindersSnapshot.docs) {
      const reminder = reminderDoc.data();
      const reminderId = reminderDoc.id;

      // Check if this reminder should be sent today
      if (!shouldSendToday(reminder.days)) {
        continue;
      }

      // Check if it's the right time to send
      if (!isTimeToSend(reminder.time)) {
        continue;
      }

      // Check if we already sent this reminder today
      if (wasSentToday(reminder.lastSent)) {
        console.log(`⏭️  Already sent reminder ${reminderId} today`);
        continue;
      }

      processedCount++;

      // Get user data
      const userDoc = await db.collection('users').doc(reminder.userId).get();
      
      if (!userDoc.exists) {
        console.log(`⚠️  User ${reminder.userId} not found`);
        continue;
      }

      const userData = userDoc.data();
      const userEmail = userData.email;
      const userName = userData.name || userData.fullName || 'Student';

      // Send the reminder email
      const emailSent = await sendReminderEmail(userEmail, userName, reminder.time);

      if (emailSent) {
        // Update the lastSent timestamp
        await db.collection('reminders').doc(reminderId).update({
          lastSent: new Date().toISOString(),
          lastSentStatus: 'success',
        });
        sentCount++;
      } else {
        await db.collection('reminders').doc(reminderId).update({
          lastSentStatus: 'failed',
          lastSentError: new Date().toISOString(),
        });
      }
    }

    console.log(`✅ Processing complete. Processed: ${processedCount}, Sent: ${sentCount}`);
    return { success: true, processed: processedCount, sent: sentCount };
  } catch (error) {
    console.error('❌ Error processing reminders:', error);
    return { success: false, error: error.message };
  }
}

// Express routes
app.get('/', (req, res) => {
  res.json({ 
    status: 'Reminder Service Running', 
    timestamp: new Date().toISOString() 
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Manual trigger endpoint (for testing)
app.get('/process-reminders', async (req, res) => {
  // Optional: Add authentication here for security
  const apiKey = req.headers['x-api-key'];
  
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const result = await processReminders();
  res.json(result);
});

// Cron job endpoint (will be called by Render Cron Job)
app.get('/cron/process-reminders', async (req, res) => {
  // Verify the request is from Render's cron system
  const cronSecret = req.headers['x-cron-secret'];
  
  if (cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const result = await processReminders();
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`🚀 Reminder service running on port ${PORT}`);
  console.log(`📧 Email configured: ${process.env.EMAIL_USER}`);
});