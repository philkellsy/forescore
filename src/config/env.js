'use strict';

const nodeEnv = process.env.NODE_ENV || 'development';
const isProd = nodeEnv === 'production';

module.exports = {
  nodeEnv,
  isProd,
  port: Number(process.env.PORT || 5050),
  baseUrl: process.env.APP_BASE_URL || process.env.BASE_URL || (isProd ? 'https://app.example.com' : 'http://localhost:5050'),
  sessionSecret: process.env.SESSION_SECRET || 'development-secret-change-me',
  dbFile: process.env.DB_FILE || './data/legends.sqlite',
  brevoApiKey: process.env.BREVO_API_KEY || '',
  brevoSenderEmail: process.env.BREVO_SENDER_EMAIL || '',
  brevoSenderName: process.env.BREVO_SENDER_NAME || 'Legends Golf',
  golfCourseApiKey: process.env.GOLF_COURSE_API_KEY || 'CPS6U7RHIJNYVP7LE5RENWJZDU'
};
