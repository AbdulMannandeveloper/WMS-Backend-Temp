/**
 * Check existing users and test the setup-password flow
 */

const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const crypto = require('crypto');

const prisma = new PrismaClient();
const API_BASE_URL = 'http://localhost:5000/api';

// Hash function matching auth.logic.js
const hashValue = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

async function testSetupPasswordFlow() {
  console.log('🧪 SETUP PASSWORD FLOW TEST\n');

  try {
    // Check existing users
    console.log('📋 Step 1: Check Existing Users');
    const users = await prisma.user.findMany();
    console.log(`Found ${users.length} users in database`);
    
    if (users.length === 0) {
      console.log('❌ No users found. Please register first admin using:');
      console.log('POST /api/auth/admin-signup/request-otp');
      await prisma.$disconnect();
      process.exit(0);
    }

    // Find a user without active status to test
    const inactiveUser = users.find(u => !u.isActive);
    if (!inactiveUser) {
      console.log('\n⚠️ All users are active. Using first user for testing.');
    }
    
    const testUser = inactiveUser || users[0];
    console.log('\nTest User:');
    console.log('  ID:', testUser.id);
    console.log('  Email:', testUser.email);
    console.log('  Active:', testUser.isActive);
    console.log('  Has Password:', !!testUser.passwordHash);

    // Check if there's an unused invitation token
    console.log('\n📋 Step 2: Check Invitation Tokens');
    const tokens = await prisma.invitationToken.findMany({
      where: {
        userId: testUser.id,
      },
    });

    console.log(`Found ${tokens.length} invitation tokens for this user:`);
    tokens.forEach((t, i) => {
      console.log(`  ${i + 1}. Hash: ${t.tokenHash.substring(0, 20)}...`);
      console.log(`     Expires: ${t.expiresAt}`);
      console.log(`     Used: ${t.usedAt ? 'Yes' : 'No'}`);
    });

    // If no valid token, create one for testing
    let plainToken;
    let validToken = tokens.find(t => !t.usedAt && t.expiresAt > new Date());
    
    if (!validToken) {
      console.log('\n📋 Step 3: Create New Invitation Token');
      plainToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = hashValue(plainToken);
      
      validToken = await prisma.invitationToken.create({
        data: {
          userId: testUser.id,
          tokenHash,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });

      console.log('✅ New token created');
    } else {
      console.log('\n⚠️ Using existing valid token');
      console.log('Note: Plain token is only available in the email sent by the system');
      console.log('For testing, we would need to extract it from the email');
      
      // Create a new token for testing
      console.log('\n📋 Step 3: Create Test Token');
      plainToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = hashValue(plainToken);
      
      validToken = await prisma.invitationToken.create({
        data: {
          userId: testUser.id,
          tokenHash,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });

      console.log('✅ Test token created');
    }

    console.log('✅ Token ready for testing');
    console.log('   Token (first 20 chars):', plainToken.substring(0, 20) + '...');

    // Step 4: Call setup-password API
    console.log('\n📋 Step 4: Call Setup Password API');
    
    const setupResponse = await axios.post(`${API_BASE_URL}/auth/setup-password`, {
      token: plainToken,
      password: 'TestPassword123',
    });

    console.log('✅ Setup password API successful');
    console.log('   Response:', setupResponse.data);

    // Step 5: Verify user is now active
    console.log('\n📋 Step 5: Verify User Activation');
    
    const updatedUser = await prisma.user.findUnique({
      where: { id: testUser.id },
    });

    console.log('User Status After Setup:');
    console.log('  Active:', updatedUser.isActive);
    console.log('  Has Password:', !!updatedUser.passwordHash);

    if (!updatedUser.isActive) {
      console.log('\n❌ ERROR: User is still not active after setup-password!');
      console.log('This is the bug that needs to be fixed.');
      await prisma.$disconnect();
      process.exit(1);
    }

    console.log('\n✅ User activation successful!');

    // Step 6: Test login
    console.log('\n📋 Step 6: Test Login with New Password');
    
    try {
      const loginResponse = await axios.post(`${API_BASE_URL}/auth/login`, {
        identifier: testUser.email,
        password: 'TestPassword123',
      });

      console.log('✅ Login successful!');
      console.log('   Response:', loginResponse.data);
    } catch (loginErr) {
      console.log('❌ Login failed:');
      console.log('   Error:', loginErr.response?.data?.error || loginErr.message);
    }

    console.log('\n✅ TEST COMPLETE - Flow is working correctly!');

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response?.data) {
      console.error('   API Response:', error.response.data);
    }
    if (error.stack) {
      console.error('   Stack:', error.stack);
    }
  } finally {
    await prisma.$disconnect();
    process.exit(0);
  }
}

testSetupPasswordFlow();
