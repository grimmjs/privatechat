# Private Chat

A **secure, end-to-end encrypted** private messaging application with Signal-grade cryptography, real-time WebSocket communication, and cross-platform support (Web, Android, iOS).

## Features

### Security & Privacy
- **End-to-End Encryption**: Signal-grade Double Ratchet algorithm for all messages
- **No Key Storage on Server**: Keys generated and managed client-side only
- **Secure Authentication**: Scrypt-based password hashing with per-record salt
- **2FA Support**: TOTP (Time-based One-Time Password) two-factor authentication
- **Recovery Codes**: Backup codes for account recovery
- **Zero-Knowledge Design**: Server cannot read messages or intercept communications

### Chat Features
- **Real-time Messaging**: WebSocket-based instant message delivery
- **Message States**: Sent, Delivered, Read status tracking
- **Message Editing**: Edit messages after sending
- **Message Deletion**: Soft delete with recipient-side support
- **Reactions**: Emoji reactions to messages
- **Message History**: Persistent message storage with pagination
- **Typing Indicators**: Real-time typing status
- **Message Replies**: Quote/reply functionality
- **Stickers**: Built-in sticker support
- **GIF Search**: Tenor API integration for GIF picker

### User & Friend Management
- **Friend System**: Friend requests with accept/reject workflow
- **User Profiles**: Username, avatar, bio, status text
- **Unique User Codes**: Share 8-character codes instead of usernames
- **Online Status**: Real-time online/offline indicators
- **User Blocks**: Block/unblock users
- **User Reports**: Report inappropriate users

### Media & Files
- **File Uploads**: Encrypted file transfer between users
- **S3 Storage**: AWS S3 integration with pre-signed URLs
- **File Sharing**: Direct peer-to-peer file links
- **Avatar Support**: User profile pictures

### Additional Features
- **Polls**: Create and vote on polls
- **Multi-Device Sync**: Session management across devices
- **Link Previews**: Automatic link preview generation
- **Push Notifications**: Web Push support with Vapid
- **Audit Logging**: Complete audit trail of user actions
- **Rate Limiting**: Protection against abuse
- **GDPR Support**: Data export and deletion endpoints

### Platform Support
- **Web**: Progressive Web App (PWA)
- **Mobile**: iOS and Android via Capacitor
- **Offline Support**: Service Worker with offline capability

## Tech Stack

### Backend
- **Runtime**: Node.js
- **Framework**: Express.js
- **Real-time**: WebSocket (ws)
- **Database**: 
  - SQLite (development, default)
  - PostgreSQL (production)
- **Cache**: Redis/Upstash (optional)
- **Logging**: Pino
- **Monitoring**: Prometheus metrics + Sentry error tracking
- **Authentication**: Scrypt + TOTP

### Frontend
- **Markup**: HTML5
- **Styling**: CSS3
- **JavaScript**: Vanilla ES6+
- **Crypto**: TweetNaCl.js (Nacl.js) + Double Ratchet algorithm
- **i18n**: Multi-language support (i18n)

### Deployment
- **Mobile Build**: Capacitor (Android + iOS)
- **PWA**: Service Worker
- **Container**: Docker-ready

## Installation

### Prerequisites
- Node.js 14+ 
- SQLite3 (development) or PostgreSQL (production)
- npm or yarn

### Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/grimmjs/privatechat.git
   cd privatechat
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with your settings:
   ```env
   PORT=3000
   DB_DRIVER=sqlite  # or 'pg' for PostgreSQL
   LOG_LEVEL=info
   ```

4. **Run database migrations**
   ```bash
   npm run migrate  # If migrate script exists
   ```

5. **Start the server**
   ```bash
   npm start        # Production
   npm run dev      # Development
   ```

Server will be available at `http://localhost:3000`

## Configuration

### Environment Variables

```env
# Server
PORT=3000
TRUST_PROXY=1               # Set to 1 if behind reverse proxy
LOG_LEVEL=info             # Logging level: debug, info, warn, error

# Database
DB_DRIVER=sqlite           # 'sqlite' or 'pg'
DATABASE_URL=              # Only for PostgreSQL

# Redis (optional)
REDIS_URL=redis://localhost:6379
UPSTASH_REDIS_REST_URL=    # For serverless deployment

# Push Notifications
VAPID_PUBLIC_KEY=          # Generate: npx web-push generate-vapid-keys
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:admin@example.com

# External APIs
TENOR_API_KEY=             # For GIF search

# WebRTC
STUN_URLS=stun:stun.l.google.com:19302
TURN_URL=                  # Optional TURN server
TURN_USERNAME=
TURN_CREDENTIAL=

# Sentry (optional)
SENTRY_DSN=                # Error tracking

# AWS S3 (if using file storage)
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
S3_BUCKET=
S3_REGION=
```

## Project Structure

```
privatechat/
├── android/               # Android app (Capacitor)
├── public/                # Frontend assets
│   ├── index.html        # Main app shell
│   ├── css/              # Stylesheets
│   ├── js/               # Client-side logic
│   │   ├── app.js        # Main application
│   │   ├── crypto.js     # Encryption/decryption
│   │   ├── calls.js      # WebRTC calls
│   │   └── ...
│   └── assets/           # Icons, images, manifest
├── database/
│   ├── db.js             # Database abstraction (SQLite + Postgres)
│   ├── migrate.js        # Migration runner
│   └── migrations/       # SQL migration files
├── modules/              # Backend business logic
│   ├── auth.js           # Authentication & registration
│   ├── chat.js           # Message handling
│   ├── friends.js        # Friend system
│   ├── users.js          # User management
│   ├── files.js          # File uploads
│   ├── security.js       # Rate limiting, audit logs
│   ├── sessions.js       # Session management
│   ├── push.js           # Push notifications
│   ├── totp.js           # 2FA tokens
│   └── ...
├── websocket/
│   └── handler.js        # WebSocket message routing
├── scripts/
│   ├── backup.js         # Database backup
│   └── cleanup.js        # Cleanup tasks
├── server.js             # Express app entry point
├── capacitor.config.json # Capacitor configuration
├── package.json
└── README.md
```

## API Overview

### Authentication
- `POST /register` - Register new account
- `POST /login` - Login user
- `POST /logout` - Logout and clear session
- `POST /recover` - Password recovery

### Messages
- WebSocket: `send_message` - Send encrypted message
- WebSocket: `edit_message` - Edit existing message
- WebSocket: `delete_message` - Delete message
- WebSocket: `mark_read` - Mark messages as read

### Friends
- WebSocket: `friend_request` - Send friend request
- WebSocket: `accept_request` - Accept friend request
- WebSocket: `reject_request` - Reject friend request
- WebSocket: `cancel_request` - Cancel outgoing request

### Users
- `GET /api/user/:id` - Get public user profile
- `POST /api/profile/avatar` - Upload profile avatar
- `POST /api/profile/update` - Update profile info

### Files
- `POST /api/upload` - Upload encrypted file
- `GET /api/file/:id` - Download file (with access control)

## Development

### Scripts
```bash
npm start              # Start production server
npm run dev           # Start with nodemon (auto-restart)
npm run backup        # Backup database
npm run syntax        # Check JavaScript syntax
npm test              # Run tests
npm run test:watch    # Run tests in watch mode
npm run test:e2e      # Run Playwright e2e tests
```

### Building Mobile Apps

#### Android
```bash
npm install  # Install dependencies
npx cap add android
npx cap build android
```

#### iOS
```bash
npx cap add ios
npx cap build ios
```

## Security Considerations

1. **HTTPS Only**: Always use HTTPS in production
2. **CORS**: Properly configure CORS for your domain
3. **Rate Limiting**: Built-in protection against brute force
4. **Session Tokens**: Secure session management
5. **Password Policy**: Enforce strong passwords
6. **Audit Logs**: All user actions are logged
7. **No Plain Backups**: Database contains hashed passwords only

## Database

### SQLite (Development)
```bash
# Data stored in data/securechat.sqlite
# Automatic migrations on startup
```

### PostgreSQL (Production)
```bash
DATABASE_URL=postgresql://user:password@host:5432/privatechat
```

Database is automatically initialized with schema on first run.

## Deployment

### Docker
```bash
docker build -t privatechat .
docker run -e PORT=3000 -e DB_DRIVER=pg -e DATABASE_URL=... privatechat
```

### Railway / Heroku
- Set `DB_DRIVER=pg`
- Set `DATABASE_URL` to your PostgreSQL connection string
- Deploy from GitHub

### Self-Hosted
1. Install Node.js and PostgreSQL
2. Clone repository
3. Install dependencies: `npm install`
4. Configure `.env`
5. Start: `npm start`

## Contributing

1. Fork the repository
2. Create feature branch: `git checkout -b feature/your-feature`
3. Make changes and commit: `git commit -am 'Add feature'`
4. Push to branch: `git push origin feature/your-feature`
5. Submit pull request

## License

Proprietary / All Rights Reserved

## Support

For issues and questions:
- GitHub Issues: [github.com/grimmjs/privatechat/issues](https://github.com/grimmjs/privatechat/issues)

## Roadmap

- [ ] Group chats
- [ ] Voice & video calls improvements
- [ ] Message search
- [ ] Dark/light theme toggle
- [ ] Desktop apps (Electron)
- [ ] Plugin system
- [ ] Self-destructing messages

---

**Made with ❤️ for privacy**
