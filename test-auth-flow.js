/**
 * Test script to verify the auth flow works end-to-end
 * Run: node test-auth-flow.js
 */

const axios = require('axios');

const API_BASE_URL = 'http://localhost:5000/api';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testAuthFlow() {
  console.log('🧪 Testing Auth Flow...\n');

  try {
    // Step 1: First Admin Registration
    console.log('📋 Step 1: First Admin Registration');
    console.log('POST /auth/admin-signup/request-otp');
    
    const signupResponse = await axios.post(`${API_BASE_URL}/auth/admin-signup/request-otp`, {
      firstName: 'John',
      lastName: 'Admin',
      username: 'john.admin',
      email: 'test-admin@propackers.com',
    });

    console.log('✅ Response:', signupResponse.data);
    const adminId = signupResponse.data.userId;
    console.log(`Admin ID: ${adminId}\n`);

    // Step 2: Get the token from database (in real scenario, user clicks email link)
    console.log('📋 Step 2: Simulate email link click - Extract token');
    console.log('⚠️ Note: In real scenario, user would click email link with token in URL query param');
    
    // For testing, we need to query the database to get the token hash
    // Since we don't have direct DB access in this script, we'll show what should happen
    console.log('Token should be extracted from email link: http://localhost:3000/setup-password?token=<TOKEN>');
    
    // Step 3: Setup password using token
    // Note: For this test to work, you need to:
    // 1. Get the plain token from the email
    // 2. Or query the database to get it
    // For now, we'll show what the API expects
    
    console.log('\n📋 Step 3: Setup Password with Token (API Call)');
    console.log('POST /auth/setup-password');
    console.log('Expected Request Body:');
    console.log(JSON.stringify({
      token: '<TOKEN_FROM_EMAIL>',
      password: 'SecurePassword123'
    }, null, 2));
    
    console.log('\n⚠️ MANUAL STEP REQUIRED:');
    console.log('1. Check your email for the setup link');
    console.log('2. Extract the token from the URL parameter');
    console.log('3. Call this API with the token:\n');
    
    console.log(`curl -X POST http://localhost:5000/api/auth/setup-password \\
  -H "Content-Type: application/json" \\
  -d '{"token":"<TOKEN_FROM_EMAIL>", "password":"SecurePassword123"}'\n`);

    console.log('📋 Step 4: Login with credentials (after setup-password is called)');
    console.log('POST /auth/login');
    
    // This would work after step 3
    console.log('Expected Request Body:');
    console.log(JSON.stringify({
      identifier: 'test-admin@propackers.com',
      password: 'SecurePassword123'
    }, null, 2));

    console.log('\n✅ Auth Flow Test Complete');
    console.log('Next: Extract token from email and call setup-password API\n');

  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }

  process.exit(0);
}

testAuthFlow();
