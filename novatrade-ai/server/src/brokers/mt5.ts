import type {
  BrokerAccountContext,
  BrokerAdapter,
  BrokerAssetClass,
  BrokerAssetInfo,
  BrokerCandle,
  BrokerCapabilities,
  BrokerConnectorDiagnostics,
  BrokerOrderPlacementResult,
  BrokerOrderReconciliationResult,
  BrokerOrderRequest,
  BrokerOrderType,
  BrokerOrderValidationResult,
  BrokerPosition,
  BrokerQuote,
  BrokerStatusSnapshot,
  BrokerTradeHistoryResult,
  InstrumentCompatibilityResult,
} from './types.ts';

const MT5_LIMITATIONS = [
  'Uses the official MetaTrader5 Python SDK hosted inside novatrade-ai/mt5-connector on a Windows machine/VPS running the MetaTrader 5 Desktop Terminal (terminal64.exe).',
  'MetaQuotes official Python wheels run only on Windows x64; a Linux cloud container cannot open MT5 IPC directly without the Windows bridge.',
  'Bridge connections are restricted strictly to ACCOUNT_TRADE_MODE_DEMO; REAL accounts are disconnected and rejected fail-closed.',
  'Binary fixed-expiry options are not supported on MetaTrader 5 (executes MARKET and LIMIT spot/CFD orders).',
];

function validateBridgeUrl(rawUrl: string): {
  valid: boolean;
  normalized: string | null;
  host: string | null;
  isLocalhost: boolean;
  warning: string | null;
} {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { valid: false, normalized: null, host: null, isLocalhost: false, warning: null };
  }
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return {
        valid: false,
        normalized: null,
        host: null,
        isLocalhost: false,
        warning: 'MT5 bridge URL must use http:// or https://',
      };
    }
    const host = u.hostname.toLowerCase();
    const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    return {
      valid: true,
      normalized: trimmed.replace(/\/+$/, ''),
      host: u.host,
      isLocalhost,
      warning: isLocalhost
        ? 'MT5 bridge URL points to localhost inside this container. Host mt5-connector on Windows alongside the MT5 terminal and provide its HTTPS URL.'
        : null,
    };
  } catch {
    return { valid: false, normalized: null, host: null, isLocalhost: false, warning: 'MT5 bridge URL is malformed.' };
  }
}

export class MetaTrader5Adapter implements BrokerAdapter {
  readonly brokerId = 'mt5' as const;
  readonly brokerName = 'MetaTrader 5 (MT5)';

  private resolveConfig(ctx?: BrokerAccountContext) {
    const rawUrl = ctx?.credentials.bridgeUrl || process.env.MT5_BRIDGE_URL || '';
    const bridgeToken = (ctx?.credentials.bridgeToken || process.env.MT5_BRIDGE_TOKEN || '').trim();
    const login = (ctx?.credentials.accountNumber || ctx?.externalAccountId || process.env.MT5_DEMO_LOGIN || '').trim();
    const serverName = (ctx?.credentials.serverName || process.env.MT5_DEMO_SERVER || 'MetaQuotes-Demo').trim() || 'MetaQuotes-Demo';
    const password = (ctx?.credentials.apiSecret || '').trim();
    const urlInfo = validateBridgeUrl(rawUrl);
    return { ...urlInfo, configured: Boolean(rawUrl.trim()), bridgeToken, login, serverName, password };
  }

  private async requestBridge<T>(path: string, init: RequestInit = {}, ctx?: BrokerAccountContext): Promise<T> {
    const cfg = this.resolveConfig(ctx);
    if (!cfg.configured || !cfg.valid || !cfg.normalized) {
      throw new Error(cfg.warning || 'MT5_BRIDGE_URL is not configured.');
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cfg.bridgeToken) headers['x-bridge-token'] = cfg.bridgeToken;

    const res = await fetch(`${cfg.normalized}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers || {}) },
      signal: AbortSignal.timeout(6500),
    });
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const text = await res.text();
    const trimmed = text.trimStart();
    const looksHtml =
      contentType.includes('text/html') ||
      (trimmed.startsWith('<') && /^(<!doctype\s+html|<html|<head|<body|<title|<h1)/i.test(trimmed));

    if (looksHtml) {
      throw new Error(`MT5 gateway returned an unexpected HTML response (HTTP ${res.status}). Check MT5_BRIDGE_URL.`);
    }

    let json: Record<string, unknown> = {};
    if (trimmed) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
          json = parsed as Record<string, unknown>;
        }
      } catch {
        if (!res.ok) {
          throw new Error(`MT5 bridge returned HTTP ${res.status}.`);
        }
        throw new Error('MT5 bridge returned a non-JSON response.');
      }
    }
    if (!res.ok) {
      throw new Error(String(json.error || json.detail || `MT5 Bridge HTTP ${res.status}`));
    }
    return json as T;
  }

  private amountToLots(amount: number): number {
    return Math.max(0.01, Math.min(2, Number((amount / 1000).toFixed(2))));
  }

  async getCapabilities(ctx?: BrokerAccountContext): Promise<BrokerCapabilities> {
    const cfg = this.resolveConfig(ctx);
    return {
      brokerId: this.brokerId,
      broker: this.brokerName,
      apiType: 'official_python_bridge',
      isOfficialApi: true,
      isPreparedAdapterOnly: !cfg.valid,
      adapterInstalled: true,
      authorisedApiVerified: false,
      connectorConfigured: cfg.valid,
      demoSupported: true,
      realAccountSupported: false,
      orderExecutionSupported: cfg.valid,
      marketDataSupported: cfg.valid,
      accountSyncSupported: cfg.valid,
      positionsSyncSupported: cfg.valid,
      historySupported: cfg.valid,
      demoOrderPlacementSupported: cfg.valid,
      liveOrderPlacementSupported: false,
      supportedAssetClasses: ['FOREX', 'COMMODITY', 'CFD'],
      supportedOrderTypes: ['MARKET', 'LIMIT'],
      environment: cfg.valid ? 'demo' : null,
      message: cfg.valid
        ? `Official MetaTrader 5 Python bridge configured (${cfg.host}) for DEMO synchronization, market quotes/candles, open positions, pre-flight order_check(), and guarded demo execution.`
        : 'Official MetaTrader 5 Python bridge ready (`novatrade-ai/mt5-connector`). Start it on Windows alongside your MT5 Demo terminal and configure the Bridge URL to connect.',
      credentialFields: [
        {
          key: 'accountNumber',
          label: 'Account Login',
          secret: false,
          required: true,
          placeholder: 'e.g. 50241890',
        },
        {
          key: 'apiSecret',
          label: 'Password',
          secret: true,
          required: true,
          placeholder: 'MT5 account password',
        },
        {
          key: 'serverName',
          label: 'Server',
          secret: false,
          required: false,
          placeholder: 'MetaQuotes-Demo',
        },
      ],
    };
  }

  async getStatus(ctx?: BrokerAccountContext): Promise<BrokerStatusSnapshot> {
    const caps = await this.getCapabilities(ctx);
    const cfg = this.resolveConfig(ctx);
    const checkedAt = new Date().toISOString();

    const baseDiag: BrokerConnectorDiagnostics = {
      configured: cfg.configured,
      urlValid: cfg.valid,
      hadVarNamePrefix: false,
      isLocalhost: cfg.isLocalhost,
      reachable: false,
      authenticated: false,
      credentialsConfigured: Boolean(cfg.login),
      tokenConfigured: Boolean(cfg.bridgeToken),
      latencyMs: null,
      targetHost: cfg.host,
      warnings: cfg.warning ? [cfg.warning] : [],
      lastConnectorError: null,
    };

    if (!cfg.configured || !cfg.valid) {
      return {
        ...caps,
        connected: false,
        executionEnabled: false,
        accountType: null,
        balance: null,
        equity: null,
        currency: null,
        connectorUrlConfigured: cfg.configured,
        lastCheckedAt: checkedAt,
        limitations: MT5_LIMITATIONS,
        diagnostics: baseDiag,
      };
    }

    const started = Date.now();
    try {
      const health = await this.requestBridge<{
        connected?: boolean;
        tradeMode?: string;
        accountLogin?: string | number;
        server?: string;
        lastError?: string | null;
      }>('/health', {}, ctx);
      const latencyMs = Date.now() - started;
      const tradeMode = String(health.tradeMode || 'DEMO').toUpperCase();
      const isDemo = tradeMode === 'DEMO';

      let balance: number | null = null;
      let equity: number | null = null;
      let currency: string | null = 'USD';
      if (health.connected) {
        try {
          const acct = await this.requestBridge<{ balance?: number; equity?: number; currency?: string }>('/account', {}, ctx);
          balance = typeof acct.balance === 'number' ? acct.balance : null;
          equity = typeof acct.equity === 'number' ? acct.equity : balance;
          currency = acct.currency || 'USD';
        } catch {
          // Optional balance read
        }
      }

      return {
        ...caps,
        authorisedApiVerified: Boolean(health.connected),
        connected: Boolean(health.connected),
        executionEnabled: isDemo && Boolean(health.connected),
        accountType: health.connected ? `${tradeMode} (${health.server || cfg.serverName || 'MT5'})` : null,
        balance,
        equity,
        currency: health.connected ? currency : null,
        connectorUrlConfigured: true,
        lastCheckedAt: checkedAt,
        message: health.connected
          ? isDemo
            ? `Connected to official MT5 Python DEMO bridge (${cfg.host}, ${latencyMs}ms).`
            : `Connected to official MT5 ${tradeMode} account (${cfg.host}, ${latencyMs}ms). Real-money order execution is locked.`
          : `MT5 bridge reachable (${latencyMs}ms); terminal session not connected yet.`,
        limitations: MT5_LIMITATIONS,
        diagnostics: {
          ...baseDiag,
          reachable: true,
          authenticated: Boolean(health.connected),
          latencyMs,
          lastConnectorError: health.lastError ?? null,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'MT5 bridge unreachable';
      return {
        ...caps,
        connected: false,
        executionEnabled: false,
        accountType: null,
        balance: null,
        equity: null,
        currency: null,
        connectorUrlConfigured: true,
        lastCheckedAt: checkedAt,
        message: `MT5 bridge unreachable (${msg}).`,
        limitations: MT5_LIMITATIONS,
        diagnostics: {
          ...baseDiag,
          reachable: false,
          latencyMs: Date.now() - started,
          lastConnectorError: msg,
        },
      };
    }
  }

  async connect(ctx?: BrokerAccountContext) {
    if (ctx?.environment === 'real') {
      throw new Error('MetaTrader 5 REAL accounts are blocked. Connect only a DEMO terminal account.');
    }
    const cfg = this.resolveConfig(ctx);
    const res = await this.requestBridge<{
      connected?: boolean;
      tradeMode?: string;
      accountType?: string;
      balance?: number;
      equity?: number;
      currency?: string;
      login?: string | number;
      server?: string;
    }>(
      '/connect',
      {
        method: 'POST',
        body: JSON.stringify({
          environment: 'demo',
          login: cfg.login || undefined,
          password: cfg.password || undefined,
          server: cfg.serverName || 'MetaQuotes-Demo',
        }),
      },
      ctx
    );
    const tradeMode = String(res.tradeMode || 'DEMO').toUpperCase();
    const isDemo = tradeMode === 'DEMO';
    return {
      connected: Boolean(res.connected),
      accountType: res.accountType || `${tradeMode} (${res.server || cfg.serverName || 'MT5'})`,
      balance: typeof res.balance === 'number' ? res.balance : null,
      equity: typeof res.equity === 'number' ? res.equity : null,
      currency: res.currency || 'USD',
      externalAccountId: res.login ? String(res.login) : cfg.login || null,
      message: res.connected
        ? isDemo
          ? 'Connected to official MetaTrader 5 DEMO Python bridge.'
          : `Connected to official MetaTrader 5 ${tradeMode} account (inspection mode; real trading locked).`
        : 'MT5 bridge did not authenticate terminal.',
    };
  }

  async disconnect(ctx?: BrokerAccountContext) {
    const cfg = this.resolveConfig(ctx);
    if (!cfg.configured || !cfg.valid) {
      return { connected: false, message: 'No MT5 bridge configured.' };
    }
    await this.requestBridge('/disconnect', { method: 'POST' }, ctx).catch(() => undefined);
    return { connected: false, message: 'Disconnected MT5 DEMO bridge session.' };
  }

  async getBalance(ctx?: BrokerAccountContext) {
    const acct = await this.requestBridge<{
      balance?: number;
      equity?: number;
      currency?: string;
      tradeMode?: string;
      server?: string;
    }>('/account', {}, ctx);
    const tradeMode = String(acct.tradeMode || 'DEMO').toUpperCase();
    const balance = typeof acct.balance === 'number' ? acct.balance : null;
    return {
      balance,
      equity: typeof acct.equity === 'number' ? acct.equity : balance,
      accountType: `${tradeMode} (${acct.server || 'MT5'})`,
      currency: acct.currency || 'USD',
      source: 'MT5_OFFICIAL_PYTHON',
    };
  }

  async getAssets(ctx?: BrokerAccountContext): Promise<{ assets: BrokerAssetInfo[]; count: number; source: string }> {
    const cfg = this.resolveConfig(ctx);
    if (!cfg.valid) {
      return { assets: [], count: 0, source: 'MT5_BRIDGE_UNCONFIGURED' };
    }
    const res = await this.requestBridge<{ symbols?: BrokerAssetInfo[] }>('/symbols', {}, ctx);
    const list = Array.isArray(res.symbols) ? res.symbols : [];
    return { assets: list, count: list.length, source: 'MT5_OFFICIAL_PYTHON' };
  }

  async getQuote(symbol: string, ctx?: BrokerAccountContext): Promise<BrokerQuote> {
    const clean = symbol.toUpperCase().replace(/[^A-Z0-9._-]/g, '');
    const res = await this.requestBridge<BrokerQuote>(`/price/${encodeURIComponent(clean)}`, {}, ctx);
    return {
      symbol: res.symbol || clean,
      bid: typeof res.bid === 'number' ? res.bid : null,
      ask: typeof res.ask === 'number' ? res.ask : null,
      last: typeof res.last === 'number' ? res.last : null,
      spread: typeof res.spread === 'number' ? res.spread : null,
      time: typeof res.time === 'number' ? res.time : null,
      source: res.source || 'MT5_OFFICIAL_PYTHON',
    };
  }

  async getCandles(
    symbol: string,
    intervalSeconds = 60,
    count = 100,
    ctx?: BrokerAccountContext
  ): Promise<{ candles: BrokerCandle[]; source: string; note?: string }> {
    const clean = symbol.toUpperCase().replace(/[^A-Z0-9._-]/g, '');
    const res = await this.requestBridge<{ candles?: BrokerCandle[]; source?: string; note?: string }>(
      '/candles',
      {
        method: 'POST',
        body: JSON.stringify({ symbol: clean, interval: intervalSeconds, count }),
      },
      ctx
    );
    return {
      candles: Array.isArray(res.candles) ? res.candles : [],
      source: res.source || 'MT5_OFFICIAL_PYTHON',
      note: res.note,
    };
  }

  async getPositions(ctx?: BrokerAccountContext): Promise<{
    supported: boolean;
    positions: BrokerPosition[];
    source: string;
    note?: string;
  }> {
    const cfg = this.resolveConfig(ctx);
    if (!cfg.valid) {
      return { supported: false, positions: [], source: 'MT5_BRIDGE_UNCONFIGURED', note: 'MT5 bridge URL is not configured.' };
    }
    const res = await this.requestBridge<{ supported?: boolean; positions?: BrokerPosition[]; source?: string }>(
      '/positions',
      {},
      ctx
    );
    const positions = Array.isArray(res.positions) ? res.positions : [];
    return {
      supported: res.supported !== false,
      positions,
      source: res.source || 'MT5_OFFICIAL_PYTHON',
      note: `${positions.length} open MT5 demo position(s).`,
    };
  }

  checkInstrumentCompatibility(
    symbol: string,
    assetClass: BrokerAssetClass,
    orderType: BrokerOrderType = 'MARKET'
  ): InstrumentCompatibilityResult {
    const clean = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (orderType === 'BINARY_FIXED_EXPIRY') {
      return {
        compatible: false,
        brokerId: this.brokerId,
        symbol: clean,
        mappedSymbol: null,
        assetClass,
        supportedOrderTypes: ['MARKET', 'LIMIT'],
        reason: 'MetaTrader 5 executes CFD/Forex MARKET and LIMIT orders, not fixed-expiry binary options.',
      };
    }
    if (assetClass === 'BINARY') {
      return {
        compatible: false,
        brokerId: this.brokerId,
        symbol: clean,
        mappedSymbol: null,
        assetClass,
        supportedOrderTypes: ['MARKET', 'LIMIT'],
        reason: 'Binary options are incompatible with MetaTrader 5.',
      };
    }
    return {
      compatible: true,
      brokerId: this.brokerId,
      symbol: clean,
      mappedSymbol: clean,
      assetClass,
      supportedOrderTypes: ['MARKET', 'LIMIT'],
      reason: `Compatible with MetaTrader 5 symbol ${clean} (verified via mt5.order_check() when connected).`,
    };
  }

  async validateOrder(ctx: BrokerAccountContext, order: BrokerOrderRequest): Promise<BrokerOrderValidationResult> {
    const assetClass: BrokerAssetClass = order.assetClass || 'FOREX';
    const compat = this.checkInstrumentCompatibility(order.symbol, assetClass, order.orderType);

    if (order.environment !== 'demo' || ctx.environment !== 'demo') {
      return {
        valid: false,
        compatible: false,
        environment: order.environment,
        symbol: order.symbol.toUpperCase(),
        mappedSymbol: null,
        direction: order.direction,
        orderType: order.orderType,
        amount: order.amount,
        normalizedVolume: null,
        estimatedMargin: null,
        freeMargin: null,
        reason: 'MT5 live orders are locked. DEMO environment only.',
        source: 'MT5_SAFETY_LOCK',
      };
    }

    if (!compat.compatible || !compat.mappedSymbol) {
      return {
        valid: false,
        compatible: false,
        environment: 'demo',
        symbol: compat.symbol,
        mappedSymbol: null,
        direction: order.direction,
        orderType: order.orderType,
        amount: order.amount,
        normalizedVolume: null,
        estimatedMargin: null,
        freeMargin: null,
        reason: compat.reason,
        source: 'MT5_COMPATIBILITY',
      };
    }

    const volumeLots = this.amountToLots(order.amount);
    const cfg = this.resolveConfig(ctx);
    if (!cfg.valid) {
      return {
        valid: false,
        compatible: true,
        environment: 'demo',
        symbol: compat.symbol,
        mappedSymbol: compat.mappedSymbol,
        direction: order.direction,
        orderType: order.orderType,
        amount: order.amount,
        normalizedVolume: volumeLots,
        estimatedMargin: null,
        freeMargin: null,
        reason: 'MT5 bridge URL is not configured; cannot execute remote mt5.order_check().',
        source: 'MT5_LOCAL_ONLY',
      };
    }

    const res = await this.requestBridge<{
      valid?: boolean;
      compatible?: boolean;
      mappedSymbol?: string;
      volume?: number;
      estimatedMargin?: number | null;
      freeMargin?: number | null;
      retcode?: number | null;
      comment?: string;
      source?: string;
    }>(
      '/order/validate',
      {
        method: 'POST',
        body: JSON.stringify({
          environment: 'demo',
          symbol: compat.mappedSymbol,
          side: order.direction === 'CALL' ? 'BUY' : 'SELL',
          orderType: order.orderType,
          volume: volumeLots,
          price: order.entryPrice,
          comment: order.idempotencyKey.slice(0, 31),
        }),
      },
      ctx
    );

    return {
      valid: Boolean(res.valid),
      compatible: res.compatible !== false,
      environment: 'demo',
      symbol: compat.symbol,
      mappedSymbol: res.mappedSymbol || compat.mappedSymbol,
      direction: order.direction,
      orderType: order.orderType,
      amount: order.amount,
      normalizedVolume: typeof res.volume === 'number' ? res.volume : volumeLots,
      estimatedMargin: typeof res.estimatedMargin === 'number' ? res.estimatedMargin : null,
      freeMargin: typeof res.freeMargin === 'number' ? res.freeMargin : null,
      retcode: typeof res.retcode === 'number' ? res.retcode : null,
      reason: res.comment || (res.valid ? 'MT5 order_check() passed.' : 'MT5 order_check() rejected order.'),
      source: res.source || 'MT5_OFFICIAL_ORDER_CHECK',
    };
  }

  async placeOrder(ctx: BrokerAccountContext, order: BrokerOrderRequest): Promise<BrokerOrderPlacementResult> {
    if (order.environment !== 'demo' || ctx.environment !== 'demo') {
      throw new Error('MT5 live orders are locked. DEMO environment only.');
    }
    const assetClass: BrokerAssetClass = order.assetClass || 'FOREX';
    const compat = this.checkInstrumentCompatibility(order.symbol, assetClass, order.orderType);
    if (!compat.compatible || !compat.mappedSymbol) {
      throw new Error(compat.reason);
    }

    const volumeLots = this.amountToLots(order.amount);
    const res = await this.requestBridge<{
      orderId?: string | number;
      status?: string;
      filledPrice?: number;
      volume?: number;
      message?: string;
    }>(
      '/order',
      {
        method: 'POST',
        body: JSON.stringify({
          environment: 'demo',
          symbol: compat.mappedSymbol,
          side: order.direction === 'CALL' ? 'BUY' : 'SELL',
          orderType: order.orderType,
          volume: volumeLots,
          price: order.entryPrice,
          comment: order.idempotencyKey.slice(0, 31),
        }),
      },
      ctx
    );
    const rawStatus = String(res.status || 'SUBMITTED').toUpperCase();
    const mappedStatus = rawStatus === 'FILLED' ? 'FILLED' : rawStatus === 'REJECTED' ? 'REJECTED' : 'SUBMITTED';
    const finalLots = typeof res.volume === 'number' ? res.volume : volumeLots;
    return {
      accepted: mappedStatus !== 'REJECTED',
      brokerOrderId: String(res.orderId || crypto.randomUUID()),
      status: mappedStatus,
      mappedSymbol: compat.mappedSymbol,
      filledPrice: typeof res.filledPrice === 'number' ? res.filledPrice : null,
      filledUnits: finalLots,
      rawStatus,
      message: res.message || `MT5 Demo order routed (${finalLots} lots on ${compat.mappedSymbol}).`,
      submittedAt: new Date().toISOString(),
    };
  }

  async getOrderStatus(ctx: BrokerAccountContext, brokerOrderId: string): Promise<BrokerOrderReconciliationResult> {
    try {
      const res = await this.requestBridge<{ status?: string; filledPrice?: number; pnl?: number; note?: string }>(
        `/orders/${encodeURIComponent(brokerOrderId)}`,
        {},
        ctx
      );
      const raw = String(res.status || 'UNKNOWN').toUpperCase();
      const status =
        raw === 'FILLED' || raw === 'CLOSED' || raw === 'CANCELLED' || raw === 'REJECTED' || raw === 'SUBMITTED'
          ? (raw as BrokerOrderReconciliationResult['status'])
          : 'UNKNOWN';
      return {
        found: true,
        brokerOrderId,
        status,
        filledPrice: typeof res.filledPrice === 'number' ? res.filledPrice : null,
        realizedPnl: typeof res.pnl === 'number' ? res.pnl : null,
        updatedAt: new Date().toISOString(),
        note: res.note || `MT5 order state: ${raw}`,
      };
    } catch (err) {
      return {
        found: false,
        brokerOrderId,
        status: 'UNKNOWN',
        filledPrice: null,
        realizedPnl: null,
        updatedAt: new Date().toISOString(),
        note: err instanceof Error ? err.message : 'Unable to query MT5 bridge order status.',
      };
    }
  }

  async getTradeHistory(ctx?: BrokerAccountContext): Promise<BrokerTradeHistoryResult> {
    const cfg = this.resolveConfig(ctx);
    if (!cfg.valid) {
      return { supported: false, trades: [], note: 'MT5 bridge URL is not configured.' };
    }
    const res = await this.requestBridge<{ trades?: Array<Record<string, unknown>>; note?: string }>('/history', {}, ctx);
    const trades = Array.isArray(res.trades) ? res.trades : [];
    return {
      supported: true,
      trades,
      note: res.note || `Synced ${trades.length} MT5 DEMO deal(s).`,
    };
  }
}
