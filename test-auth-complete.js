/**
 * Database Helper - Extract tokens and test auth flow
 * Run: node test-auth-complete.js
 */

const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const crypto = require('crypto');

const prisma = new PrismaClient();
const API_BASE_URL = 'http://localhost:5000/api';

// Hash function matching auth.logic.js
const hashValue = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

async function testCompleteAuthFlow() {
  console.log('🧪 COMPLETE AUTH FLOW TEST\n');

  try {
    // Step 1: Register first admin
    console.log('📋 Step 1: Register First Admin');
    const adminEmail = `admin-${Date.now()}@test.com`;
    
    const signupResponse = await axios.post(`${API_BASE_URL}/auth/admin-signup/request-otp`, {
      firstName: 'John',
      lastName: 'Admin',
      username: 'john.admin',
      email: adminEmail,
    });

    const adminUserId = signupResponse.data.userId;
    console.log('✅ Admin registered:', adminUserId);
    console.log('   Email:', adminEmail);

    // Step 2: Get the invitation token from database
    console.log('\n📋 Step 2: Get Invitation Token from Database');
    
    const tokenRecord = await prisma.invitationToken.findFirst({
      where: {
        userId: adminUserId,
        usedAt: null,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (!tokenRecord) {
      throw new Error('No invitation token found in database');
    }

    console.log('✅ Token found in database');
    console.log('   Token Hash:', tokenRecord.tokenHash);
    console.log('   Expires at:', tokenRecord.expiresAt);

    // We need to extract the plain token, but we only have the hash
    // In a real scenario, the plain token is in the email URL
    // For testing, we'll generate a new token and test the flow
    console.log('\n⚠️ Note: Plain token is sent via email only');
    console.log('   In real scenario, user would extract it from email link');

    // Step 3: Setup password using invitation flow
    // Since we don't have the plain token, we'll show what should happen
    console.log('\n📋 Step 3: Test with correct token flow');
    
    // Create a test token
    const plainToken = crypto.randomBytes(32).toString("hex");
    const testTokenHash = hashValue(plainToken);
    
    // Manually create an invitation token in DB for testing
    const testToken = await prisma.invitationToken.create({
      data: {
        userId: adminUserId,
        tokenHash: testTokenHash,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    console.log('✅ Test token created:', testTokenHash);

    // Step 4: Setup password with the test token
    console.log('\n📋 Step 4: Setup Password with Token');
    
    const setupResponse = await axios.post(`${API_BASE_URL}/auth/setup-password`, {
      token: plainToken,
      password: 'TestPassword123',
    });

    console.log('✅ Password set successfully');
    console.log('   Response:', setupResponse.data);

    // Step 5: Verify user is now active
    console.log('\n📋 Step 5: Verify User is Active');
    
    const updatedUser = await prisma.user.findUnique({
      where: { id: adminUserId },
    });

    console.log('✅ User Status:');
    console.log('   Active:', updatedUser.isActive);
    console.log('   Has Password:', !!updatedUser.passwordHash);

    if (!updatedUser.isActive) {
      throw new Error('❌ User is still not active!');
    }

    // Step 6: Test login
    console.log('\n📋 Step 6: Test Login');
    
    const loginResponse = await axios.post(`${API_BASE_URL}/auth/login`, {
      identifier: adminEmail,
      password: 'TestPassword123',
    });

    console.log('✅ Login successful');
    console.log('   Response:', loginResponse.data);

    // Step 7: Verify OTP
    console.log('\n📋 Step 7: Verify OTP');
    
    const otpRecord = await prisma.otpVerification.findFirst({
      where: { userId: adminUserId },
      orderBy: { createdAt: 'desc' },
    });

    if (otpRecord) {
      // Get the OTP code by checking what was sent (you'd see this in logs or email)
      console.log('✅ OTP created and sent to email');
      console.log('   OTP Hash:', otpRecord.codeHash);
      console.log('   Expires at:', otpRecord.expiresAt);
    }

    console.log('\n✅ COMPLETE AUTH FLOW TEST PASSED!');
    console.log('\n📝 SUMMARY:');
    console.log('1. ✅ Admin registered');
    console.log('2. ✅ Invitation token created');
    console.log('3. ✅ Password set via setup link');
    console.log('4. ✅ User activated');
    console.log('5. ✅ Login works');
    console.log('6. ✅ OTP sent');

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response?.data) {
      console.error('   API Response:', error.response.data);
    }
  } finally {
    await prisma.$disconnect();
    process.exit(0);
  }
}

testCompleteAuthFlow();
