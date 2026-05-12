'use strict';

const nodeEnv = process.env.NODE_ENV || 'development';
const isProd = nodeEnv === 'production';

module.exports = {
  nodeEnv,
  isProd,
  port: Number(process.env.PORT || 2080),
  databaseUrl: process.env.DATABASE_URL ||
    (process.env.PGHOST
      ? `postgresql://${process.env.PGUSER}:${encodeURIComponent(process.env.PGPASSWORD || '')}@${process.env.PGHOST}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE}`
      : 'postgresql://localhost:5432/forescore_dev'),
  baseUrl: process.env.APP_BASE_URL || (isProd ? 'https://app.forescore.golf' : 'http://localhost:5050'),
  sessionSecret: process.env.SESSION_SECRET || 'development-secret-change-me',
  brevoApiKey: process.env.BREVO_API_KEY || '',
  brevoSenderEmail: process.env.BREVO_SENDER_EMAIL || '',
  brevoSenderName: process.env.BREVO_SENDER_NAME || 'ForeScore',
  golfCourseApiKey: process.env.GOLF_COURSE_API_KEY || '',
};
