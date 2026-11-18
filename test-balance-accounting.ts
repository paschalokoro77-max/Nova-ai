import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NovaTradeEngine } from './novatrade-ai/server/src/tradingEngine.ts';

async function runBalanceAccountingTests() {
  console.log('=== NOVATRADE AI: BALANCE ACCOUNTING REFINEMENT INTEGRATION TESTS ===\n');

  const testStatePath = path.resolve(process.cwd(), '.novatrade-data/test-accounting-state.json');
  if (fs.existsSync(testStatePath)) {
    try { fs.unlinkSync(testStatePath); } catch {}
  }

  let passed = 0;
  try {
    const engine = new NovaTradeEngine(testStatePath, 'acc-user');
    engine.setStartingVirtualBalance(1000);
    engine.riskSettings.maxTradeAmount = 1000; // allow up to 1000 for testing balance limits

    console.log('1. Initial Balance Summary:', engine.getVirtualBalanceSummary());

    // Test 1: Opening a trade (reserve exact stake, show reserved balance separately)
    console.log('\n--- Test 1: Opening Trade & Reserving Stake ---');
    const openRes = engine.openPaperTrade({
      symbol: 'EURUSD',
      timeframe: '1m',
      direction: 'CALL',
      amount: 100,
      mode: 'automatic',
      entryPrice: 1.0850,
      expirySeconds: 180,
      signalScore: 80,
      provider: 'accounting-test',
      pendingOutcome: true,
      userId: 'acc-user',
    });
    assert.equal(openRes.ok, true);
    const trade = openRes.trade!;
    const summaryAfterOpen = engine.getVirtualBalanceSummary();
    console.log(`- Trade Opened ID: ${trade.id}`);
    console.log(`- Balance Summary After Open:`, summaryAfterOpen);
    assert.equal(summaryAfterOpen.reservedBalance, 100);
    assert.equal(summaryAfterOpen.currentBalance, 900);
    assert.equal(summaryAfterOpen.totalEquity, 1000);
    passed += 1;
    console.log('-> Test 1 PASSED: Stake reserved successfully; available balance and reserved balance correctly tracked.\n');

    // Test 2: Insufficient Balance Check (isolate from daily loss limit without weakening engine risk logic)
    console.log('\n--- Test 2: Insufficient Balance Check ---');
    const prevDailyLossLimit = engine.riskSettings.dailyLossLimit;
    engine.riskSettings.dailyLossLimit = 2000; // isolate available cash check ($900 available vs $950 stake)
    const openRes2 = engine.openPaperTrade({
      symbol: 'GBPUSD',
      timeframe: '1m',
      direction: 'PUT',
      amount: 950, // exceeds available $900 balance (since $100 is reserved)
      mode: 'automatic',
      entryPrice: 1.2650,
      expirySeconds: 180,
      signalScore: 80,
      provider: 'accounting-test',
      pendingOutcome: true,
      userId: 'acc-user',
    });
    engine.riskSettings.dailyLossLimit = prevDailyLossLimit; // restore original daily loss limit

    console.log(`- Insufficient Balance Trade Result: ${openRes2.ok ? 'SUCCESS (Unexpected)' : 'REJECTED: ' + openRes2.error}`);
    assert.equal(openRes2.ok, false);
    assert.ok(openRes2.error?.includes('Insufficient available virtual balance'), `Unexpected error: ${openRes2.error}`);
    const summaryAfterRejected = engine.getVirtualBalanceSummary();
    assert.equal(summaryAfterRejected.currentBalance, 900);
    assert.equal(summaryAfterRejected.reservedBalance, 100);
    passed += 1;
    console.log('-> Test 2 PASSED: Trade rejected due to insufficient available cash (reserved funds protected).\n');

    // Test 3: Winning Trade Settlement (release reserved stake, credit net profit exactly once)
    console.log('\n--- Test 3: Winning Trade Settlement ---');
    const settleWin = engine.settlePaperTrade(trade.id, 'win', 80, 1.0920, 'take-profit-triggered');
    const summaryAfterWin = engine.getVirtualBalanceSummary();
    console.log(`- Win Settlement PnL: ${settleWin.trade?.pnl}`);
    console.log(`- Balance Summary After Win:`, summaryAfterWin);
    assert.equal(settleWin.ok, true);
    assert.equal(summaryAfterWin.totalEquity, 1080);
    assert.equal(summaryAfterWin.currentBalance, 1080);
    assert.equal(summaryAfterWin.reservedBalance, 0);
    passed += 1;
    console.log('-> Test 3 PASSED: Winning trade released reserved stake and credited net profit exactly once.\n');

    // Test 4: Losing Trade Settlement (consume reserved stake as loss, no double deduction)
    console.log('\n--- Test 4: Losing Trade Settlement ---');
    const openLossRes = engine.openPaperTrade({
      symbol: 'USDJPY',
      timeframe: '1m',
      direction: 'PUT',
      amount: 100,
      mode: 'automatic',
      entryPrice: 150.00,
      expirySeconds: 180,
      signalScore: 75,
      provider: 'accounting-test',
      pendingOutcome: true,
      userId: 'acc-user',
    });
    assert.equal(openLossRes.ok, true);
    const lossTrade = openLossRes.trade!;
    console.log(`- Loss Trade Opened, Reserved Balance: ${engine.getVirtualBalanceSummary().reservedBalance}`);
    const settleLoss = engine.settlePaperTrade(lossTrade.id, 'loss', 100, 151.00, 'stop-loss-triggered');
    const summaryAfterLoss = engine.getVirtualBalanceSummary();
    console.log(`- Loss Settlement PnL: ${settleLoss.trade?.pnl}`);
    console.log(`- Balance Summary After Loss:`, summaryAfterLoss);
    assert.equal(settleLoss.ok, true);
    assert.equal(summaryAfterLoss.totalEquity, 980);
    assert.equal(summaryAfterLoss.currentBalance, 980);
    assert.equal(summaryAfterLoss.reservedBalance, 0);
    passed += 1;
    console.log('-> Test 4 PASSED: Losing trade consumed reserved stake as loss without double deduction.\n');

    // Test 5: Cancellation / Failed order (release reservation, leave balance unchanged)
    console.log('\n--- Test 5: Trade Cancellation / Release Reservation ---');
    const openCancelRes = engine.openPaperTrade({
      symbol: 'AUDUSD',
      timeframe: '1m',
      direction: 'CALL',
      amount: 200,
      mode: 'automatic',
      entryPrice: 0.6550,
      expirySeconds: 180,
      signalScore: 70,
      provider: 'accounting-test',
      pendingOutcome: true,
      userId: 'acc-user',
    });
    assert.equal(openCancelRes.ok, true);
    const cancelTrade = openCancelRes.trade!;
    console.log(`- Balance Before Cancel (Available): $${engine.getVirtualBalanceSummary().currentBalance}, Reserved: ${engine.getVirtualBalanceSummary().reservedBalance}`);
    const cancelRes = engine.cancelPaperTrade(cancelTrade.id);
    const summaryAfterCancel = engine.getVirtualBalanceSummary();
    console.log(`- Balance Summary After Cancel:`, summaryAfterCancel);
    assert.equal(cancelRes.ok, true);
    assert.equal(summaryAfterCancel.reservedBalance, 0);
    assert.equal(summaryAfterCancel.currentBalance, 980);
    assert.equal(summaryAfterCancel.totalEquity, 980);
    passed += 1;
    console.log('-> Test 5 PASSED: Cancellation released reservation and restored available balance.\n');

    // Test 6: Duplicate Settlement Protection (both cancelled trade and already-settled winning trade)
    console.log('\n--- Test 6: Duplicate Settlement Protection ---');
    const dupSettleCancelled = engine.settlePaperTrade(cancelTrade.id, 'win', 50, 0.6600, 'manual');
    const dupSettleWon = engine.settlePaperTrade(trade.id, 'win', 80, 1.0920, 'manual');
    console.log(`- Duplicate Settlement Result (Cancelled): ${dupSettleCancelled.ok ? 'SUCCESS (Unexpected)' : 'BLOCKED AS EXPECTED: ' + dupSettleCancelled.error}`);
    console.log(`- Duplicate Settlement Result (Already Won): ${dupSettleWon.ok ? 'SUCCESS (Unexpected)' : 'BLOCKED AS EXPECTED: ' + dupSettleWon.error}`);
    assert.equal(dupSettleCancelled.ok, false);
    assert.equal(dupSettleCancelled.status, 404);
    assert.equal(dupSettleWon.ok, false);
    assert.equal(dupSettleWon.status, 404);
    assert.equal(engine.getVirtualBalanceSummary().totalEquity, 980);
    passed += 1;
    console.log('-> Test 6 PASSED: Duplicate settlement prevented atomically.\n');

    // Test 7: Server Restart State Recovery
    console.log('\n--- Test 7: Server Restart State Recovery ---');
    const engineRestarted = new NovaTradeEngine(testStatePath, 'acc-user');
    const recoveredSummary = engineRestarted.getVirtualBalanceSummary();
    console.log(`- Recovered Balance Summary:`, recoveredSummary);
    assert.equal(recoveredSummary.totalEquity, 980);
    assert.equal(recoveredSummary.currentBalance, 980);
    assert.equal(recoveredSummary.reservedBalance, 0);
    assert.equal(recoveredSummary.startingBalance, 1000);
    assert.equal(recoveredSummary.totalNetPnl, -20);
    passed += 1;
    console.log('-> Test 7 PASSED: Balance accounting state recovered successfully after server restart.\n');

    console.log(`=== BALANCE ACCOUNTING TESTS COMPLETE (${passed}/7 PASSED) ===`);
  } finally {
    if (fs.existsSync(testStatePath)) {
      try { fs.unlinkSync(testStatePath); } catch {}
    }
  }
}

runBalanceAccountingTests().catch((err) => {
  console.error('Balance accounting tests failed:', err);
  process.exit(1);
});
