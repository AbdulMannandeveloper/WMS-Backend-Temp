# 🔐 Email Activation Link - Complete Guide

## Overview

The activation link sent via email allows users to set their password and activate their account in one step. Here's how it works:

---

## 📋 Complete Flow Explanation

### Step 1: Admin Registers / Invites User
```bash
# First Admin Registration
POST /api/auth/admin-signup/request-otp

# Admin Inviting User
POST /api/auth/admin/users/invite
```

**Payload:**
```json
{
  "firstName": "John",
  "lastName": "Doe",
  "email": "john@example.com",
  "username": "john.doe"
}
```

### Step 2: Backend Creates User & Token
**In Database:**
- User created with `isActive: false` and `passwordHash: null`
- Invitation token generated with:
  - 64-character random hex string (plain token)
  - SHA-256 hashed version stored in DB (never store plain token)
  - Expiration: 24 hours (configurable via `INVITE_EXPIRY_HOURS`)

### Step 3: Email Sent to User
**Subject:** "Set Your ProPackers Account Password"

**Email Content:**
```
An administrator created your account. 
Click below to set your password.

[Set Password Button]
or
http://localhost:5000/setup-password?token=ABC123DEF456...

This link expires in 24 hours.
```

### Step 4: User Clicks Email Link
- Link opens setup page at `http://localhost:5000/setup-password?token=...`
- Frontend extracts token from URL
- Shows password setup form

### Step 5: User Sets Password
**Setup Page Features:**
- ✅ Password strength indicator (Weak/Medium/Strong)
- ✅ Real-time password confirmation checking
- ✅ Minimum 6 character requirement
- ✅ Submit button disabled until valid
- ✅ Loading spinner during submission
- ✅ Error messages for invalid tokens
- ✅ Success message with auto-redirect

**User enters:**
```
Password: MySecurePassword123
Confirm: MySecurePassword123
```

### Step 6: Frontend Calls Backend API
**Request:**
```
POST /api/auth/setup-password
Content-Type: application/json

{
  "token": "ABC123DEF456...",
  "password": "MySecurePassword123"
}
```

### Step 7: Backend Activates Account
**Backend does:**

```javascript
1. Receive token from frontend
2. Hash token using SHA-256
3. Look up token hash in InvitationToken table
4. Verify:
   ✅ Token exists
   ✅ Token not expired (expiresAt > now)
   ✅ Token not already used (usedAt == null)
5. Hash password using bcrypt (10 rounds)
6. Update user:
   - passwordHash = bcrypted password
   - isActive = true
7. Mark token as used:
   - usedAt = current timestamp
8. Return success response
```

### Step 8: Account is Activated ✅
**User can now:**
- ✅ Login with email/username + password
- ✅ Receive OTP for 2FA verification
- ✅ Access protected endpoints

---

## 🔒 Security Features

### Token Security
| Feature | Benefit |
|---------|---------|
| **64-char hex** | Cryptographically secure random token |
| **SHA-256 Hash** | Tokens cannot be recovered from database |
| **24hr expiry** | Old tokens automatically invalidated |
| **One-time use** | Token marked as used after first submission |
| **Email delivery** | Plain token only in email, not in DB |

### Password Security
| Feature | Benefit |
|---------|---------|
| **Bcrypt hashing** | Industry standard password hashing |
| **10 salt rounds** | Slows down brute force attacks |
| **Min 6 chars** | Minimum strength requirement |
| **HTTPS only** | Should be used in production |

---

## 🧪 Testing the Flow

### Test Scenario 1: First Admin Registration

**1. Register First Admin**
```bash
curl -X POST http://localhost:5000/api/auth/admin-signup/request-otp \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "John",
    "lastName": "Admin",
    "email": "test-admin@example.com",
    "username": "john.admin"
  }'
```

**Expected Response:**
```json
{
  "message": "Invitation link sent to email. Please verify and set password to complete signup.",
  "userId": "550e8400-e29b-41d4-a716-446655440000",
  "email": "test-admin@example.com"
}
```

**What happens:**
- ✅ User created with `isActive: false`
- ✅ Invitation token generated
- ✅ Email sent with setup link

**2. Check Email**
- Check inbox/spam for email from `ubaidmohammad901@gmail.com`
- Copy the token from the setup link URL

**3. Open Setup Link**
```
Click: http://localhost:5000/setup-password?token=ABC123...

Or manually navigate to:
http://localhost:5000/setup-password?token=ABC123...
```

**4. Set Password via Setup Page**
- Enter password: `AdminPass123`
- Confirm password: `AdminPass123`
- Click "Set Password"

**Expected Response:**
```json
{
  "message": "Password set successfully.",
  "completed": true,
  "userId": "550e8400-e29b-41d4-a716-446655440000"
}
```

**5. Verify Account is Active**
```bash
curl http://localhost:5000/api/users \
  -H "Content-Type: application/json"
```

Check that user `isActive: true` and has `passwordHash`

**6. Login**
```bash
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "identifier": "test-admin@example.com",
    "password": "AdminPass123"
  }'
```

**Expected Response:**
```json
{
  "message": "Login successful. OTP sent to email.",
  "userId": "550e8400-e29b-41d4-a716-446655440000"
}
```

✅ **Success!** Account is now active and functional.

---

### Test Scenario 2: Admin Invites Employee

**1. Admin Invites Employee**
```bash
curl -X POST http://localhost:5000/api/auth/admin/users/invite \
  -H "Content-Type: application/json" \
  -d '{
    "adminId": "550e8400-e29b-41d4-a716-446655440000",
    "firstName": "Jane",
    "lastName": "Employee",
    "email": "jane@example.com",
    "username": "jane.emp",
    "role": "employee"
  }'
```

**Expected Response:**
```json
{
  "message": "Invitation sent successfully.",
  "invited": true,
  "userId": "660e8400-e29b-41d4-a716-446655440001",
  "email": "jane@example.com"
}
```

**2. Employee receives email → clicks link → sets password**
Same process as Step 3-5 above

**3. Employee can now login**
```bash
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "identifier": "jane@example.com",
    "password": "EmployeePass123"
  }'
```

---

## ⚙️ Configuration

### Environment Variables
```env
# Backend URL for email links
APP_BASE_URL=http://localhost:5000

# Token expiration
INVITE_EXPIRY_HOURS=24

# OTP settings
OTP_EXPIRY_MINUTES=20
OTP_MAX_ATTEMPTS=5

# Email settings
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
MAIL_FROM=your-email@gmail.com
```

### Frontend Setup Page Location
```
File: /public/setup-password.html
Served by: Express static middleware
URL: http://localhost:5000/setup-password?token=...
```

---

## 🚨 Error Handling

### Common Errors & Solutions

| Error | Cause | Solution |
|-------|-------|----------|
| "No setup token found in URL" | Link copied incorrectly | Use full email link |
| "Invalid or expired token" | Token expired (24h) | Request new invitation |
| "Token already used" | Link used twice | Request new invitation |
| "Passwords do not match" | Confirmation mismatch | Re-enter passwords carefully |
| "Password must be at least 6 characters" | Password too short | Use longer password |
| "The account is not active" | Setup not completed | Click setup link in email |

---

## 📊 Database State Changes

### Before Setup Link Click
```sql
-- Users Table
SELECT * FROM users WHERE email='test@example.com';
{
  id: 'ABC123...',
  email: 'test@example.com',
  isActive: false,        -- NOT ACTIVE ❌
  passwordHash: null,     -- NO PASSWORD
  createdAt: '2026-05-02T00:00:00Z',
  updatedAt: '2026-05-02T00:00:00Z'
}

-- Invitation Tokens Table
SELECT * FROM invitation_tokens WHERE user_id='ABC123...';
{
  id: 'TOKEN123...',
  userId: 'ABC123...',
  tokenHash: 'SHA256HASH...',
  expiresAt: '2026-05-03T00:00:00Z',
  usedAt: null           -- NOT USED
}
```

### After Setup Link Click
```sql
-- Users Table (UPDATED)
SELECT * FROM users WHERE email='test@example.com';
{
  id: 'ABC123...',
  email: 'test@example.com',
  isActive: true,                    -- ✅ ACTIVE NOW
  passwordHash: '$2b$10$...',        -- ✅ PASSWORD SET
  createdAt: '2026-05-02T00:00:00Z',
  updatedAt: '2026-05-02T00:05:30Z'  -- UPDATED
}

-- Invitation Tokens Table (MARKED USED)
SELECT * FROM invitation_tokens WHERE user_id='ABC123...';
{
  id: 'TOKEN123...',
  userId: 'ABC123...',
  tokenHash: 'SHA256HASH...',
  expiresAt: '2026-05-03T00:00:00Z',
  usedAt: '2026-05-02T00:05:30Z'    -- ✅ MARKED USED
}
```

---

## 🎯 Summary

| Stage | Status | Action |
|-------|--------|--------|
| **User Created** | `isActive: false` | Email sent with setup link |
| **Setup Link Clicked** | Link opened | Frontend page loads |
| **Password Set** | API called | Backend validates token |
| **Token Verified** | Valid & unused | Account activated |
| **User Activated** | `isActive: true` | Can now login |
| **Token Marked Used** | Used | Cannot be used again |

✅ **The account activation link system is now fully functional!**
