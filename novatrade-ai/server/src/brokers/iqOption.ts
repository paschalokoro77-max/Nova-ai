import type {
  BrokerAccountContext,
  BrokerAdapter,
  BrokerAssetClass,
  BrokerAssetInfo,
  BrokerCandle,
  BrokerCapabilities,
  BrokerConnectorDiagnostics,
  BrokerOrderType,
  BrokerQuote,
  BrokerStatusSnapshot,
  BrokerTradeHistoryResult,
  InstrumentCompatibilityResult,
} from './types.ts';

const IQ_LIMITATIONS = [
  'IQ Option does not provide an officially documented public retail trading API.',
  'The self-hosted iq-connector relies on the unofficial community iqoptionapi package (PRACTICE / read-only diagnostics).',
  'Accounts requiring 2FA, captcha verification, or restricted by jurisdiction cannot authenticate automatically.',
  'Order placement on IQ Option remains locked (fail-closed) due to unofficial connector status.',
];

export interface ParsedIqConnectorConfig {
  configured: boolean;
  url: string | null;
  urlValid: boolean;
  hadVarNamePrefix: boolean;
  isLocalhost: boolean;
  targetHost: string | null;
  tokenConfigured: boolean;
  warnings: string[];
}

export function parseIqConnectorConfig(
  rawInput = process.env.IQ_CONNECTOR_URL || '',
  tokenInput = process.env.IQ_CONNECTOR_TOKEN || ''
): ParsedIqConnectorConfig {
  let raw = rawInput.trim();
  const tokenConfigured = Boolean(tokenInput.trim());
  if (!raw) {
    return {
      configured: false,
      url: null,
      urlValid: false,
      hadVarNamePrefix: false,
      isLocalhost: false,
      targetHost: null,
      tokenConfigured,
      warnings: [],
    };
  }

  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }

  const warnings: string[] = [];
  let hadVarNamePrefix = false;
  if (/^IQ_CONNECTOR_URL\s*=/i.test(raw)) {
    hadVarNamePrefix = true;
    raw = raw.replace(/^IQ_CONNECTOR_URL\s*=\s*/i, '').trim();
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      raw = raw.slice(1, -1).trim();
    }
    warnings.push(
      'IQ_CONNECTOR_URL contained the "IQ_CONNECTOR_URL=" variable name prefix. Store only the URL value (e.g. https://your-connector.example).'
    );
  }

  if (!raw) {
    return {
      configured: true,
      url: null,
      urlValid: false,
      hadVarNamePrefix,
      isLocalhost: false,
      targetHost: null,
      tokenConfigured,
      warnings: [...warnings, 'IQ_CONNECTOR_URL is empty after stripping the variable name prefix.'],
    };
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        configured: true,
        url: null,
        urlValid: false,
        hadVarNamePrefix,
        isLocalhost: false,
        targetHost: null,
        tokenConfigured,
        warnings: [...warnings, 'IQ_CONNECTOR_URL must use http:// or https:// protocol.'],
      };
    }

    const host = parsed.hostname.toLowerCase();
    const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    if (isLocalhost) {
      warnings.push(
        `IQ_CONNECTOR_URL points to ${parsed.hostname}, which refers to this container itself. Deploy novatrade-ai/iq-connector separately and set its public HTTPS URL.`
      );
    }

    const normalized = raw.replace(/\/+$/, '');
    return {
      configured: true,
      url: normalized,
      urlValid: true,
      hadVarNamePrefix,
      isLocalhost,
      targetHost: parsed.host,
      tokenConfigured,
      warnings,
    };
  } catch {
    return {
      configured: true,
      url: null,
      urlValid: false,
      hadVarNamePrefix,
      isLocalhost: false,
      targetHost: null,
      tokenConfigured,
      warnings: [...warnings, 'IQ_CONNECTOR_URL is not a valid URL. Provide only the http(s) base URL.'],
    };
  }
}

export class IQOptionAdapter implements BrokerAdapter {
  readonly brokerId = 'iq_option' as const;
  readonly brokerName = 'IQ Option';

  private getConfig(ctx?: BrokerAccountContext): ParsedIqConnectorConfig {
    const url = ctx?.credentials.bridgeUrl || process.env.IQ_CONNECTOR_URL || '';
    const token = ctx?.credentials.bridgeToken || process.env.IQ_CONNECTOR_TOKEN || '';
    return parseIqConnectorConfig(url, token);
  }

  private getHeaders(ctx?: BrokerAccountContext): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const token = (ctx?.credentials.bridgeToken || process.env.IQ_CONNECTOR_TOKEN || '').trim();
    if (token) headers['x-connector-token'] = token;
    return headers;
  }

  private async requestConnector<T>(path: string, init: RequestInit = {}, ctx?: BrokerAccountContext): Promise<T> {
    const cfg = this.getConfig(ctx);
    if (!cfg.configured) {
      throw new Error('IQ_CONNECTOR_URL is not configured.');
    }
    if (!cfg.urlValid || !cfg.url) {
      throw new Error(cfg.warnings[0] || 'IQ_CONNECTOR_URL is invalid.');
    }
    const res = await fetch(`${cfg.url}${path}`, {
      ...init,
      headers: { ...this.getHeaders(ctx), ...(init.headers || {}) },
      signal: AbortSignal.timeout(6000),
    });
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const text = await res.text();
    const trimmed = text.trimStart();
    const looksHtml =
      contentType.includes('text/html') ||
      (trimmed.startsWith('<') && /^(<!doctype\s+html|<html|<head|<body|<title|<h1)/i.test(trimmed));

    if (looksHtml) {
      throw new Error(`IQ Option connector returned an unexpected HTML response (HTTP ${res.status}).`);
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
          throw new Error(`IQ Option connector HTTP ${res.status}.`);
        }
        throw new Error('IQ Option connector returned a non-JSON response.');
      }
    }
    if (!res.ok) {
      const msg = String(json.detail || json.error || `Connector HTTP ${res.status}`);
      throw new Error(msg);
    }
    return json as T;
  }

  async getCapabilities(ctx?: BrokerAccountContext): Promise<BrokerCapabilities> {
    const cfg = this.getConfig(ctx);
    return {
      brokerId: this.brokerId,
      broker: this.brokerName,
      apiType: 'unofficial_connector',
      isOfficialApi: false,
      isPreparedAdapterOnly: !cfg.urlValid,
      adapterInstalled: cfg.urlValid,
      authorisedApiVerified: false,
      connectorConfigured: cfg.urlValid,
      demoSupported: cfg.urlValid,
      realAccountSupported: false,
      orderExecutionSupported: false,
      marketDataSupported: cfg.urlValid,
      accountSyncSupported: cfg.urlValid,
      positionsSyncSupported: false,
      historySupported: cfg.urlValid,
      demoOrderPlacementSupported: false,
      liveOrderPlacementSupported: false,
      supportedAssetClasses: ['FOREX', 'CRYPTO', 'BINARY'],
      supportedOrderTypes: ['BINARY_FIXED_EXPIRY'],
      environment: cfg.urlValid ? 'demo' : null,
      message: !cfg.configured
        ? 'IQ_CONNECTOR_URL is not set. Configure a private iq-connector instance for PRACTICE read-only diagnostics.'
        : !cfg.urlValid
          ? cfg.warnings[0] || 'IQ_CONNECTOR_URL is malformed.'
          : `IQ Option PRACTICE read-only connector configured (${cfg.targetHost}). Order execution remains locked.`,
      credentialFields: [
        {
          key: 'email',
          label: 'Email',
          secret: false,
          required: true,
          placeholder: 'your-email@example.com',
        },
        {
          key: 'apiSecret',
          label: 'Password',
          secret: true,
          required: true,
          placeholder: 'IQ Option password',
        },
      ],
    };
  }

  async getStatus(ctx?: BrokerAccountContext): Promise<BrokerStatusSnapshot> {
    const caps = await this.getCapabilities(ctx);
    const cfg = this.getConfig(ctx);
    const checkedAt = new Date().toISOString();

    const baseDiagnostics: BrokerConnectorDiagnostics = {
      configured: cfg.configured,
      urlValid: cfg.urlValid,
      hadVarNamePrefix: cfg.hadVarNamePrefix,
      isLocalhost: cfg.isLocalhost,
      reachable: false,
      authenticated: false,
      credentialsConfigured: null,
      tokenConfigured: cfg.tokenConfigured,
      latencyMs: null,
      targetHost: cfg.targetHost,
      warnings: [...cfg.warnings],
      lastConnectorError: null,
    };

    if (!cfg.configured || !cfg.urlValid || !cfg.url) {
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
        limitations: IQ_LIMITATIONS,
        diagnostics: baseDiagnostics,
      };
    }

    const started = Date.now();
    try {
      const health = await this.requestConnector<{
        connected?: boolean;
        mode?: string;
        credentialsConfigured?: boolean;
        lastError?: string | null;
      }>('/health', {}, ctx);
      const latencyMs = Date.now() - started;

      let balance: number | null = null;
      let accountType: string | null = health.connected ? 'PRACTICE' : null;
      let currency: string | null = null;

      if (health.connected) {
        try {
          const acct = await this.requestConnector<{
            accountType?: string;
            balance?: number;
            currency?: string;
          }>('/account', {}, ctx);
          balance = typeof acct.balance === 'number' ? acct.balance : null;
          accountType = acct.accountType || 'PRACTICE';
          currency = acct.currency || 'USD';
        } catch {
          // Keep health connected state even if /account fails transiently
        }
      }

      const diagnostics: BrokerConnectorDiagnostics = {
        ...baseDiagnostics,
        reachable: true,
        authenticated: Boolean(health.connected),
        credentialsConfigured:
          typeof health.credentialsConfigured === 'boolean' ? health.credentialsConfigured : null,
        latencyMs,
        lastConnectorError: health.lastError ?? null,
      };

      const warningSuffix = cfg.warnings.length > 0 ? ` (${cfg.warnings[0]})` : '';
      return {
        ...caps,
        connected: Boolean(health.connected),
        executionEnabled: false,
        accountType,
        balance,
        equity: balance,
        currency,
        connectorUrlConfigured: true,
        lastCheckedAt: checkedAt,
        message: health.connected
          ? `Connected to IQ Option connector (${accountType || 'PRACTICE'} read-only, ${latencyMs}ms). Order execution locked.${warningSuffix}`
          : health.credentialsConfigured
            ? `IQ connector reachable (${latencyMs}ms); not authenticated (${health.lastError || 'click Connect to initiate PRACTICE session'}).${warningSuffix}`
            : `IQ connector reachable (${latencyMs}ms), but IQ_EMAIL / IQ_PASSWORD are not set on the connector host.${warningSuffix}`,
        limitations: IQ_LIMITATIONS,
        diagnostics,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'connection failed';
      const diagnostics: BrokerConnectorDiagnostics = {
        ...baseDiagnostics,
        reachable: false,
        latencyMs: Date.now() - started,
        lastConnectorError: errMsg,
      };
      const warningHint = cfg.warnings.length > 0 ? ` ${cfg.warnings.join(' ')}` : '';
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
        message: `IQ connector unreachable (${errMsg}).${warningHint}`,
        limitations: IQ_LIMITATIONS,
        diagnostics,
      };
    }
  }

  async connect(ctx?: BrokerAccountContext) {
    if (ctx?.environment === 'real') {
      throw new Error('IQ Option real accounts are locked. Only PRACTICE read-only diagnostics are permitted.');
    }
    const creds = ctx?.credentials || {};
    const res = await this.requestConnector<{ connected?: boolean; accountType?: string; mode?: string }>(
      '/connect',
      {
        method: 'POST',
        body: JSON.stringify({
          email: creds.email || undefined,
          password: creds.apiSecret || undefined,
        }),
      },
      ctx
    );
    let balance: number | null = null;
    let currency: string | null = 'USD';
    if (res.connected) {
      try {
        const acct = await this.getBalance(ctx);
        balance = acct.balance;
        currency = acct.currency;
      } catch {
        // Optional balance read after connect
      }
    }
    return {
      connected: Boolean(res.connected),
      accountType: res.accountType || res.mode || 'PRACTICE',
      balance,
      equity: balance,
      currency,
      externalAccountId: 'iq-practice',
      message: res.connected
        ? 'Authenticated with IQ Option connector in PRACTICE read-only mode. Order placement remains disabled.'
        : 'IQ Option connector did not confirm an active session.',
    };
  }

  async disconnect(ctx?: BrokerAccountContext): Promise<{ connected: boolean; message: string }> {
    const cfg = this.getConfig(ctx);
    if (!cfg.configured || !cfg.urlValid) {
      return { connected: false, message: 'No valid IQ Option connector configured.' };
    }
    await this.requestConnector('/disconnect', { method: 'POST' }, ctx).catch(() => undefined);
    return { connected: false, message: 'Disconnected from IQ Option connector.' };
  }

  async getBalance(ctx?: BrokerAccountContext) {
    const acct = await this.requestConnector<{ balance?: number; accountType?: string; currency?: string; source?: string }>(
      '/account',
      {},
      ctx
    );
    const bal = typeof acct.balance === 'number' ? acct.balance : null;
    return {
      balance: bal,
      equity: bal,
      accountType: acct.accountType || 'PRACTICE',
      currency: acct.currency || 'USD',
      source: acct.source || 'IQ_OPTION_UNOFFICIAL',
    };
  }

  async getAssets(ctx?: BrokerAccountContext): Promise<{ assets: BrokerAssetInfo[]; count: number; source: string }> {
    const res = await this.requestConnector<{ assets?: BrokerAssetInfo[]; count?: number; source?: string }>('/assets', {}, ctx);
    const assets = Array.isArray(res.assets) ? res.assets : [];
    return {
      assets,
      count: typeof res.count === 'number' ? res.count : assets.length,
      source: res.source || 'IQ_OPTION_UNOFFICIAL',
    };
  }

  async getQuote(symbol: string, ctx?: BrokerAccountContext): Promise<BrokerQuote> {
    const clean = symbol.toUpperCase().replace(/[^A-Z0-9._-]/g, '');
    try {
      const res = await this.requestConnector<BrokerQuote>(`/price/${encodeURIComponent(clean)}`, {}, ctx);
      return {
        symbol: res.symbol || clean,
        bid: typeof res.bid === 'number' ? res.bid : null,
        ask: typeof res.ask === 'number' ? res.ask : null,
        last: typeof res.last === 'number' ? res.last : null,
        spread: typeof res.spread === 'number' ? res.spread : null,
        time: typeof res.time === 'number' ? res.time : null,
        source: res.source || 'IQ_OPTION_UNOFFICIAL',
        note: res.note,
      };
    } catch {
      const fallback = await this.getCandles(clean, 60, 2, ctx);
      const latest = fallback.candles[fallback.candles.length - 1];
      return {
        symbol: clean,
        bid: null,
        ask: null,
        last: latest ? latest.close : null,
        spread: null,
        time: latest ? latest.time : null,
        source: fallback.source || 'IQ_OPTION_UNOFFICIAL',
        note: 'Derived from latest unofficial 1m candle close.',
      };
    }
  }

  async getCandles(
    symbol: string,
    intervalSeconds = 60,
    count = 100,
    ctx?: BrokerAccountContext
  ): Promise<{ candles: BrokerCandle[]; source: string; note?: string }> {
    const res = await this.requestConnector<{ candles?: BrokerCandle[]; source?: string; note?: string }>(
      '/candles',
      {
        method: 'POST',
        body: JSON.stringify({ symbol, interval: intervalSeconds, count }),
      },
      ctx
    );
    return {
      candles: Array.isArray(res.candles) ? res.candles : [],
      source: res.source || 'IQ_OPTION_UNOFFICIAL',
      note: res.note,
    };
  }

  checkInstrumentCompatibility(
    symbol: string,
    assetClass: BrokerAssetClass,
    orderType: BrokerOrderType = 'BINARY_FIXED_EXPIRY'
  ): InstrumentCompatibilityResult {
    const clean = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (orderType !== 'BINARY_FIXED_EXPIRY') {
      return {
        compatible: false,
        brokerId: this.brokerId,
        symbol: clean,
        mappedSymbol: null,
        assetClass,
        supportedOrderTypes: ['BINARY_FIXED_EXPIRY'],
        reason: 'IQ Option connector is read-only PRACTICE diagnostics and does not execute MARKET/LIMIT spot orders.',
      };
    }
    if (assetClass === 'COMMODITY') {
      return {
        compatible: false,
        brokerId: this.brokerId,
        symbol: clean,
        mappedSymbol: null,
        assetClass,
        supportedOrderTypes: ['BINARY_FIXED_EXPIRY'],
        reason: 'IQ Option asset list must be confirmed open via Fetch Open Assets; commodity futures are incompatible.',
      };
    }
    return {
      compatible: false,
      brokerId: this.brokerId,
      symbol: clean,
      mappedSymbol: clean,
      assetClass,
      supportedOrderTypes: ['BINARY_FIXED_EXPIRY'],
      reason: 'IQ Option order execution is locked (read-only unofficial connector); route binary research to NovaTrade Paper Simulator.',
    };
  }

  async getTradeHistory(ctx?: BrokerAccountContext): Promise<BrokerTradeHistoryResult> {
    const cfg = this.getConfig(ctx);
    if (!cfg.configured || !cfg.urlValid) {
      return {
        supported: false,
        trades: [],
        note: cfg.warnings[0] || 'IQ_CONNECTOR_URL is not configured.',
      };
    }
    const res = await this.requestConnector<BrokerTradeHistoryResult>('/history', {}, ctx);
    return {
      supported: Boolean(res.supported),
      trades: Array.isArray(res.trades) ? res.trades : [],
      note: res.note || 'Retrieved from IQ Option connector.',
    };
  }
}
