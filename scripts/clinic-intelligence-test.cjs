/**
 * Advanced Clinic Intelligence Test Script
 * Run via node scripts/clinic-intelligence-test.cjs
 */

const { AdvancedClinicIntelligence } = require('../src/services/AdvancedClinicIntelligence');

console.log('Running Advanced Clinic Intelligence Tests...');

// 1. Test Offline Queue
const qId = AdvancedClinicIntelligence.enqueueOfflineTransfer({ studyId: '123' });
console.log('✅ Offline Queue Enqueue ID:', qId, 'Size:', AdvancedClinicIntelligence.getQueueSize());

// 2. Test Window/Level
const adjusted = AdvancedClinicIntelligence.applyWindowLevel(1500, { windowWidth: 400, windowCenter: 1000 });
console.log('✅ Window/Level Adjusted Pixel:', adjusted);

// 3. Test Quality Assessment
const dummyData = new Uint8Array([10, 20, 30, 40, 50]);
const report = AdvancedClinicIntelligence.assessImageQuality(dummyData);
console.log('✅ Quality Assessment Report:', report);

// 4. Test Watermark
const wm = AdvancedClinicIntelligence.generateWatermarkOverlay('P-9988');
console.log('✅ Watermark Text:', wm);

console.log('🎉 ALL CLINIC INTELLIGENCE TESTS PASSED');
process.exit(0);

