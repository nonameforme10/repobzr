const path = require('path');

module.exports = {
  apps: [
    {
      name: 'bozor-backend',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 5000
      }
    },
    {
      name: 'bozor-telegram-bot',
      script: 'telegram_bot/run.py',
      interpreter: 'python3',
      cwd: path.resolve(__dirname, '..'),
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        PYTHONUNBUFFERED: '1'
      }
    }
  ]
};
