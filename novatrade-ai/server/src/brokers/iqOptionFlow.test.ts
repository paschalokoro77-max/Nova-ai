import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrokerConnectionManager } from './connectionManager.ts';
import { BrokerRegistry } from './registry.ts';
import { analyzeMarketQuant } from '../quantEngine.ts';
import type { Candle } from '../marketData.ts';

interface MockConnectorState {
  connected: boolean;
  mode: 'PRACTICE' | 'REAL';
  practiceBalance: number;
  realBalance: number;
  accountTransientTimeoutCount: number;
  connectCalls: number;
  disconnectCalls: number;
  modeSwitchCalls: number;
  orderCalls: Array<Record<string, unknown>>;
  openPositions: Array<{
    ticket: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    volume: number;
    openPrice: number;
    currentPrice: number;
    profit: number;
    openedAt: string;
    expiresAt: string;
    instrumentType: string;
    mode: 'PRACTICE' | 'REAL';
    canClose: boolean;
  }>;
  closedHistory: Array<Record<string, unknown>>;
  nextOrderId: number;
}

function startMockIqConnector(state: MockConnectorState): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = urlObj.pathname;
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown> = {};
        if (rawBody) {
          try {
            body = JSON.parse(rawBody) as Record<string, unknown>;
          } catch {
            body = {};
          }
        }

        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };

        const currentBalance = state.mode === 'REAL' ? state.realBalance : state.practiceBalance;

        if (req.method === 'GET' && pathname === '/health') {
          return send(200, {
            status: 'running',
            version: '0.5.0',
            serviceAvailable: true,
            busy: false,
            connectInFlight: false,
            authenticated: state.connected,
            connected: state.connected,
            mode: state.connected ? state.mode : null,
            activeMode: state.connected ? state.mode : null,
            accountType: state.connected ? state.mode : null,
            modeVerified: state.connected,
            modeFollowsBroker: true,
            orderExecutionSupported: true,
            positionsSupported: true,
            closePositionSupported: true,
            realTradingEnabled: state.connected && state.mode === 'REAL',
            credentialsConfigured: true,
          });
        }

        if (req.method === 'POST' && pathname === '/connect') {
          state.connectCalls += 1;
          if (body.password === 'wrong-password') {
            return send(401, { detail: 'IQ Option authentication failed: invalid credentials.' });
          }
          state.connected = true;
          return send(200, {
            connected: true,
            mode: state.mode,
            activeMode: state.mode,
            accountType: state.mode,
            modeVerified: true,
            modeFollowsBroker: true,
            orderExecutionSupported: true,
            positionsSupported: true,
            closePositionSupported: true,
            realTradingEnabled: state.mode === 'REAL',
          });
        }

        if (req.method === 'POST' && pathname === '/disconnect') {
          state.disconnectCalls += 1;
          state.connected = false;
          return send(200, { disconnected: true });
        }

        if (req.method === 'GET' && (pathname === '/account' || pathname === '/balance')) {
          if (state.accountTransientTimeoutCount > 0) {
            state.accountTransientTimeoutCount -= 1;
            return send(504, { detail: 'IQ Option upstream timed out retrieving balance.' });
          }
          if (!state.connected) {
            return send(401, { detail: 'Not connected' });
          }
          return send(200, {
            connected: true,
            mode: state.mode,
            activeMode: state.mode,
            accountType: state.mode,
            modeVerified: true,
            modeFollowsBroker: true,
            balance: currentBalance,
            currency: 'USD',
            orderExecutionSupported: true,
            positionsSupported: true,
            closePositionSupported: true,
            realTradingEnabled: state.mode === 'REAL',
            source: 'IQ_OPTION_UNOFFICIAL',
          });
        }

        if (req.method === 'GET' && pathname.startsWith('/price/')) {
          const symbol = decodeURIComponent(pathname.slice('/price/'.length)).toUpperCase();
          return send(200, {
            symbol,
            bid: null,
            ask: null,
            last: 1.0865,
            spread: null,
            time: Math.floor(Date.now() / 1000),
            mode: state.mode,
            orderExecutionSupported: true,
            realTradingEnabled: state.mode === 'REAL',
            source: 'IQ_OPTION_UNOFFICIAL',
          });
        }

        if (req.method === 'POST' && pathname === '/candles') {
          const count = Math.min(200, Math.max(10, Number(body.count) || 60));
          const nowEpoch = Math.floor(Date.now() / 1000);
          const candles: Candle[] = [];
          let price = 1.0800;
          for (let i = 0; i < count; i += 1) {
            const open = price;
            const close = Number((open + 0.00018 + (i % 4 === 0 ? -0.00004 : 0.00005)).toFixed(5));
            const high = Number((Math.max(open, close) + 0.00008).toFixed(5));
            const low = Number((Math.min(open, close) - 0.00006).toFixed(5));
            candles.push({
              time: nowEpoch - (count - i) * 60,
              open,
              high,
              low,
              close,
              volume: 120 + i,
            });
            price = close;
          }
          return send(200, {
            symbol: String(body.symbol || 'EURUSD'),
            interval: Number(body.interval || 60),
            candles,
            mode: state.mode,
            orderExecutionSupported: true,
            realTradingEnabled: state.mode === 'REAL',
            source: 'IQ_OPTION_UNOFFICIAL',
          });
        }

        if (req.method === 'POST' && pathname === '/order') {
          const expectedMode = body.expectedMode ? String(body.expectedMode).toUpperCase() : null;
          if (expectedMode && expectedMode !== state.mode) {
            return send(409, {
              detail: `IQ Option active account mode mismatch: expected ${expectedMode}, live is ${state.mode}.`,
            });
          }
          const oid = String(state.nextOrderId++);
          const symbol = String(body.symbol || 'EURUSD').toUpperCase();
          const direction = String(body.direction || 'CALL').toUpperCase();
          const amount = Number(body.amount || 10);
          const expirySeconds = Number(body.expirySeconds || 180);
          state.orderCalls.push({ ...body, verifiedMode: state.mode, brokerOrderId: oid });
          if (state.mode === 'REAL') {
            state.realBalance = Number((state.realBalance - amount).toFixed(2));
          } else {
            state.practiceBalance = Number((state.practiceBalance - amount).toFixed(2));
          }
          state.openPositions.push({
            ticket: oid,
            symbol,
            side: direction === 'PUT' ? 'SELL' : 'BUY',
            volume: amount,
            openPrice: 1.0865,
            currentPrice: 1.0870,
            profit: 6.5,
            openedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + expirySeconds * 1000).toISOString(),
            instrumentType: 'binary',
            mode: state.mode,
            canClose: true,
          });
          return send(200, {
            accepted: true,
            brokerOrderId: oid,
            status: 'FILLED',
            mappedSymbol: symbol,
            direction,
            amount,
            expirySeconds,
            instrumentType: 'binary',
            mode: state.mode,
            accountType: state.mode,
            modeVerified: true,
            filledPrice: 1.0865,
            filledUnits: amount,
            rawStatus: 'OPEN',
            message: `Opened ${direction} ${symbol} on IQ Option (${state.mode}).`,
            submittedAt: new Date().toISOString(),
          });
        }

        if (req.method === 'GET' && pathname === '/positions') {
          return send(200, {
            supported: true,
            mode: state.mode,
            positions: state.openPositions,
            source: 'IQ_OPTION_UNOFFICIAL',
            note: `Active positions (${state.mode}).`,
          });
        }

        if (req.method === 'POST' && /^\/positions\/[^/]+\/close$/.test(pathname)) {
          const oid = decodeURIComponent(pathname.split('/')[2]);
          const idx = state.openPositions.findIndex((p) => p.ticket === oid);
          if (idx === -1) {
            return send(404, { detail: `Position ${oid} not found.` });
          }
          const [closedPos] = state.openPositions.splice(idx, 1);
          const realizedPnl = 8.4;
          if (closedPos.mode === 'REAL') {
            state.realBalance = Number((state.realBalance + closedPos.volume + realizedPnl).toFixed(2));
          } else {
            state.practiceBalance = Number((state.practiceBalance + closedPos.volume + realizedPnl).toFixed(2));
          }
          state.closedHistory.unshift({
            id: oid,
            symbol: closedPos.symbol,
            direction: closedPos.side === 'BUY' ? 'CALL' : 'PUT',
            amount: closedPos.volume,
            pnl: realizedPnl,
            mode: closedPos.mode,
            status: 'CLOSED',
            closedAt: new Date().toISOString(),
          });
          return send(200, {
            closed: true,
            brokerOrderId: oid,
            status: 'CLOSED',
            realizedPnl,
            mode: closedPos.mode,
            message: `Closed IQ Option position ${oid} (${closedPos.mode}).`,
            closedAt: new Date().toISOString(),
          });
        }

        if (req.method === 'GET' && pathname.startsWith('/orders/')) {
          const oid = decodeURIComponent(pathname.slice('/orders/'.length));
          const isOpen = state.openPositions.some((p) => p.ticket === oid);
          const settled = state.closedHistory.find((h) => String(h.id) === oid);
          if (settled) {
            return send(200, {
              brokerOrderId: oid,
              status: 'CLOSED',
              filledPrice: 1.0865,
              realizedPnl: Number(settled.pnl),
              mode: state.mode,
              note: 'Closed trade reconciled.',
            });
          }
          return send(200, {
            brokerOrderId: oid,
            status: isOpen ? 'FILLED' : 'UNKNOWN',
            filledPrice: 1.0865,
            realizedPnl: null,
            mode: state.mode,
            note: isOpen ? 'Open position active.' : 'Order not found.',
          });
        }

        if (req.method === 'GET' && pathname === '/history') {
          return send(200, {
            supported: true,
            mode: state.mode,
            trades: state.closedHistory,
            note: `Synchronized ${state.closedHistory.length} closed trades (${state.mode}).`,
          });
        }

        return send(404, { detail: `Unhandled mock route ${req.method} ${pathname}` });
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      assert.ok(addr && typeof addr !== 'string');
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

test('End-to-end IQ Option workflow: auth, dedup, stale protection, market data, AI analysis, PRACTICE trade lifecycle, REAL auto-detection, stability', async () => {
  const state: MockConnectorState = {
    connected: false,
    mode: 'PRACTICE',
    practiceBalance: 7428.71,
    realBalance: 250.0,
    accountTransientTimeoutCount: 0,
    connectCalls: 0,
    disconnectCalls: 0,
    modeSwitchCalls: 0,
    orderCalls: [],
    openPositions: [],
    closedHistory: [
      {
        id: 'hist-100',
        symbol: 'EURUSD',
        direction: 'CALL',
        amount: 10,
        pnl: 7.5,
        mode: 'PRACTICE',
        status: 'CLOSED',
        closedAt: new Date(Date.now() - 3600_000).toISOString(),
      },
    ],
    nextOrderId: 9001,
  };

  const mockServer = await startMockIqConnector(state);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novatrade-iq-test-'));
  const prevUrl = process.env.IQ_CONNECTOR_URL;
  const prevToken = process.env.IQ_CONNECTOR_TOKEN;
  process.env.IQ_CONNECTOR_URL = mockServer.url;
  process.env.IQ_CONNECTOR_TOKEN = 'test-token-123';

  try {
    const manager = new BrokerConnectionManager(new BrokerRegistry(), path.join(tmpDir, 'state.json'));
    const userId = 'user-owner-1';

    // 1 & 2. Auth + PRACTICE connection + balance retrieval (7428.71)
    const acct = await manager.createOrUpdateAccount(userId, {
      brokerId: 'iq_option',
      label: 'IQ Option (owner@example.com)',
      credentials: { email: 'owner@example.com', apiSecret: 'valid-secret' },
    });
    const connected = await manager.connectAccount(userId, acct.id);
    assert.equal(connected.connected, true);
    assert.equal(connected.status, 'CONNECTED');
    assert.equal(connected.accountType, 'PRACTICE');
    assert.equal(connected.environment, 'demo');
    assert.equal(connected.balance, 7428.71);
    assert.equal(connected.isAuthoritative, true);

    // 12. Duplicate prevention on repeated same-email login submissions
    const iqCountBeforeResave = (await manager.listAccounts(userId)).accounts.filter(
      (a) => a.brokerId === 'iq_option'
    ).length;
    const reSaved = await manager.createOrUpdateAccount(userId, {
      brokerId: 'iq_option',
      label: 'IQ Option (owner@example.com)',
      credentials: { email: 'owner@example.com', apiSecret: 'valid-secret-updated' },
    });
    assert.equal(reSaved.id, acct.id, 'Same-email IQ login must update existing record in place without creating duplicates');
    const listAfterResave = await manager.listAccounts(userId);
    assert.equal(
      listAfterResave.accounts.filter((a) => a.brokerId === 'iq_option').length,
      iqCountBeforeResave,
      'Repeated same-email login must not increase IQ Option account count'
    );

    // Simulate legacy stale duplicate IQ records + an MT5 account to test stale-card protection & opt-in cleanup
    const staleDuplicate = await manager.createOrUpdateAccount(userId, {
      brokerId: 'iq_option',
      label: 'IQ Option Legacy Shell',
      credentials: { email: 'old-stale@example.com', apiSecret: 'stale-pw' },
    });
    const mt5Acct = await manager.createOrUpdateAccount(userId, {
      brokerId: 'mt5',
      label: 'MT5 Preserved Demo',
      environment: 'demo',
      credentials: { accountNumber: '123456', apiSecret: 'mt5-pw', serverName: 'MetaQuotes-Demo' },
    });
    const listWithDup = await manager.listAccounts(userId);
    const taggedAuth = listWithDup.accounts.find((a) => a.id === acct.id);
    const taggedStale = listWithDup.accounts.find((a) => a.id === staleDuplicate.id);
    assert.equal(taggedAuth?.isAuthoritative, true);
    assert.equal(taggedAuth?.isStaleDuplicate, false);
    assert.equal(taggedStale?.isAuthoritative, false);
    assert.equal(taggedStale?.isStaleDuplicate, true);

    // Stale card disconnect MUST NOT disconnect the active authoritative session!
    const disconnectBefore = state.disconnectCalls;
    await manager.disconnectAccount(userId, staleDuplicate.id);
    assert.equal(state.disconnectCalls, disconnectBefore, 'Disconnecting a stale IQ card must NOT call connector /disconnect');
    assert.equal(state.connected, true, 'Active IQ Option PRACTICE session must remain connected');

    // Opt-in cleanup removes ONLY stale disconnected IQ duplicates and preserves authoritative IQ account + MT5
    const cleanupRes = await manager.cleanupStaleIqDuplicates(userId);
    assert.ok(cleanupRes.removedIds.includes(staleDuplicate.id), 'Stale duplicate must be removed on opt-in cleanup');
    assert.ok(!cleanupRes.removedIds.includes(acct.id), 'Authoritative connected IQ account must NEVER be removed');
    assert.equal(cleanupRes.keptAccountId, acct.id);
    const listAfterCleanup = await manager.listAccounts(userId);
    assert.equal(listAfterCleanup.accounts.filter((a) => a.brokerId === 'iq_option').length, 1);
    assert.equal(listAfterCleanup.accounts.some((a) => a.id === mt5Acct.id), true, 'MT5 account must remain untouched');

    // 4. Candle and market data retrieval
    const quote = await manager.getAccountQuote(userId, acct.id, 'EURUSD');
    assert.equal(quote.last, 1.0865);
    const candleRes = await manager.getAccountCandles(userId, acct.id, 'EURUSD', 60, 80);
    assert.ok(candleRes.candles.length >= 60);

    // 5. AI analysis on live candles + strict rejection of missing/stale data
    const liveAnalysis = analyzeMarketQuant('EURUSD', '1m', candleRes.candles, 'IQ Option Live Connector', {
      marketStatus: 'LIVE',
      isStale: false,
    });
    assert.equal(liveAnalysis.isStale, false);
    assert.ok(liveAnalysis.score >= 0 && liveAnalysis.score <= 100);
    assert.ok(liveAnalysis.indicators !== null);

    const missingAnalysis = analyzeMarketQuant('EURUSD', '1m', [], 'unavailable', {
      marketStatus: 'UNAVAILABLE',
      isStale: true,
    });
    assert.equal(missingAnalysis.direction, 'WAIT');
    assert.equal(missingAnalysis.actionableConfidence, 0);
    assert.equal(missingAnalysis.isStale, true);

    const staleAnalysis = analyzeMarketQuant('EURUSD', '1m', candleRes.candles, 'IQ Option Live Connector', {
      marketStatus: 'DELAYED',
      isStale: true,
    });
    assert.equal(staleAnalysis.direction, 'WAIT');
    assert.equal(staleAnalysis.actionableConfidence, 0);
    assert.equal(staleAnalysis.isStale, true);

    // 6. Select IQ Option as active execution target + validate + open PRACTICE trade
    const selected = await manager.selectActiveAccount(userId, acct.id);
    assert.equal(selected.activeAccountId, acct.id);

    const validation = await manager.validateDemoOrder(userId, {
      accountId: acct.id,
      symbol: 'EURUSD',
      assetClass: 'FOREX',
      direction: 'CALL',
      orderType: 'BINARY_FIXED_EXPIRY',
      amount: 25,
      entryPrice: 1.0865,
      expirySeconds: 180,
      globalEmergencyStop: false,
    });
    assert.equal(validation.valid, true);
    assert.equal(validation.environment, 'demo');

    const placed = await manager.executeDemoOrder(userId, {
      accountId: acct.id,
      symbol: 'EURUSD',
      assetClass: 'FOREX',
      direction: 'CALL',
      orderType: 'BINARY_FIXED_EXPIRY',
      amount: 25,
      entryPrice: 1.0865,
      expirySeconds: 180,
      idempotencyKey: 'iq-practice-trade-1',
      source: 'manual',
      globalEmergencyStop: false,
    });
    assert.equal(Boolean(placed.duplicatePrevented), false);
    assert.equal(placed.order.status, 'FILLED');
    assert.equal(placed.order.environment, 'demo');
    assert.equal(state.orderCalls.length, 1);
    assert.equal(state.orderCalls[0].expectedMode, 'PRACTICE');

    // Idempotency duplicate protection
    const dupPlaced = await manager.executeDemoOrder(userId, {
      accountId: acct.id,
      symbol: 'EURUSD',
      assetClass: 'FOREX',
      direction: 'CALL',
      orderType: 'BINARY_FIXED_EXPIRY',
      amount: 25,
      entryPrice: 1.0865,
      expirySeconds: 180,
      idempotencyKey: 'iq-practice-trade-1',
      source: 'manual',
      globalEmergencyStop: false,
    });
    assert.equal(dupPlaced.duplicatePrevented, true);
    assert.equal(state.orderCalls.length, 1);

    // 7. Monitor active open trade
    const openPos = await manager.getAccountPositions(userId, acct.id);
    assert.equal(openPos.supported, true);
    assert.equal(openPos.positions.length, 1);
    assert.equal(openPos.positions[0].ticket, placed.order.brokerOrderId);
    assert.equal(openPos.positions[0].mode, 'PRACTICE');

    // 8. Close PRACTICE trade + verify ledger & balance sync
    const closeRes = await manager.closeAccountPosition(userId, acct.id, placed.order.brokerOrderId);
    assert.equal(closeRes.closed, true);
    assert.equal(closeRes.status, 'CLOSED');
    assert.equal(closeRes.realizedPnl, 8.4);

    const openPosAfterClose = await manager.getAccountPositions(userId, acct.id);
    assert.equal(openPosAfterClose.positions.length, 0);

    // 9. Trade history synchronization
    const histSync = await manager.syncAccountTradeHistory(userId, acct.id);
    assert.equal(histSync.supported, true);
    assert.ok(histSync.trades.length >= 2);
    assert.ok(histSync.learnedRecords.length >= 1);

    // 11. Connection stability after repeated status checks + transient timeout preservation
    for (let i = 0; i < 5; i += 1) {
      const synced = await manager.checkHealthAndSyncBalance(userId, acct.id);
      assert.equal(synced.connected, true);
      assert.equal(synced.status, 'CONNECTED');
      assert.equal(synced.accountType, 'PRACTICE');
      assert.equal(synced.balance, Number((7428.71 + 8.4).toFixed(2)));
    }

    // Transient /account 504 timeout while /health is alive must preserve healthy CONNECTED state & balance!
    state.accountTransientTimeoutCount = 1;
    const afterTransient = await manager.checkHealthAndSyncBalance(userId, acct.id);
    assert.equal(afterTransient.connected, true, 'Transient timeout must NOT overwrite healthy connected session');
    assert.equal(afterTransient.status, 'CONNECTED');
    assert.equal(afterTransient.balance, Number((7428.71 + 8.4).toFixed(2)));

    // 10. Dynamic REAL mode auto-detection (user switches inside IQ Option; NovaTrade detects & follows without switching)
    state.mode = 'REAL';
    const syncedReal = await manager.checkHealthAndSyncBalance(userId, acct.id);
    assert.equal(syncedReal.connected, true);
    assert.equal(syncedReal.accountType, 'REAL');
    assert.equal(syncedReal.environment, 'real');
    assert.equal(syncedReal.balance, 250.0);
    assert.equal(state.modeSwitchCalls, 0, 'NovaTrade must NEVER switch IQ Option account mode internally');

    const placedReal = await manager.executeDemoOrder(userId, {
      accountId: acct.id,
      symbol: 'EURUSD',
      assetClass: 'FOREX',
      direction: 'PUT',
      orderType: 'BINARY_FIXED_EXPIRY',
      amount: 10,
      entryPrice: 1.0865,
      expirySeconds: 60,
      idempotencyKey: 'iq-real-trade-1',
      source: 'manual',
      globalEmergencyStop: false,
    });
    assert.equal(placedReal.order.environment, 'real');
    assert.equal(state.orderCalls[1].expectedMode, 'REAL');
    assert.equal(state.orderCalls[1].verifiedMode, 'REAL');
    assert.equal(state.modeSwitchCalls, 0);
  } finally {
    if (prevUrl === undefined) delete process.env.IQ_CONNECTOR_URL;
    else process.env.IQ_CONNECTOR_URL = prevUrl;
    if (prevToken === undefined) delete process.env.IQ_CONNECTOR_TOKEN;
    else process.env.IQ_CONNECTOR_TOKEN = prevToken;
    await mockServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
