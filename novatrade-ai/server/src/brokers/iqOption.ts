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

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

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

  private readonly inflightConnect = new Map<
    string,
    Promise<{
      connected: boolean;
      accountType: string | null;
      balance: number | null;
      equity: number | null;
      currency: string | null;
      externalAccountId: string | null;
      message: string;
    }>
  >();

  private readonly inflightStatus = new Map<string, Promise<BrokerStatusSnapshot>>();

  private getConfig(ctx?: BrokerAccountContext): ParsedIqConnectorConfig {
    const url = ctx?.credentials.bridgeUrl || process.env.IQ_CONNECTOR_URL || '';
    const token = ctx?.credentials.bridgeToken || process.env.IQ_CONNECTOR_TOKEN || '';
    return parseIqConnectorConfig(url, token);
  }

  private getHeaders(ctx?: BrokerAccountContext): Record<string, string> {
    const requestedMode = ctx?.environment === 'real' ? 'REAL' : 'PRACTICE';
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-iq-mode': requestedMode,
    };
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

    const isHealth = path === '/health';
    const isConnect = path === '/connect';
    const maxAttempts = 2;
    // Align /connect client timeout (28s) above the connector's bounded connect+mode budget (~23s)
    // so Node does not abort and pile up duplicate handshakes while the connector is still finishing.
    const timeoutMs = isHealth ? 10000 : isConnect ? 28000 : 18000;
    const baseBackoffMs = isConnect ? 2000 : 1200;
    let lastErr: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(`${cfg.url}${path}`, {
          ...init,
          headers: { ...this.getHeaders(ctx), ...(init.headers || {}) },
          signal: AbortSignal.timeout(timeoutMs),
        });

        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        const text = await res.text();
        const trimmed = text.trimStart();
        const looksHtml =
          contentType.includes('text/html') ||
          (trimmed.startsWith('<') && /^(<!doctype\s+html|<html|<head|<body|<title|<h1)/i.test(trimmed));

        if (looksHtml) {
          if (res.status === 502 || res.status === 503 || res.status === 504) {
            if (attempt < maxAttempts) {
              await new Promise((r) => setTimeout(r, baseBackoffMs * attempt));
              continue;
            }
            const htmlErr = new Error(
              `IQ Option connector gateway returned HTTP ${res.status} HTML (service cold start or upstream timeout).`
            ) as Error & { status?: number; nonRetryable?: boolean };
            htmlErr.status = res.status;
            htmlErr.nonRetryable = true;
            throw htmlErr;
          }
          const htmlErr = new Error(`IQ Option connector returned an unexpected HTML response (HTTP ${res.status}).`) as Error & {
            status?: number;
            nonRetryable?: boolean;
          };
          htmlErr.status = res.status;
          htmlErr.nonRetryable = true;
          throw htmlErr;
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
              if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < maxAttempts) {
                await new Promise((r) => setTimeout(r, baseBackoffMs * attempt));
                continue;
              }
              const parseErr = new Error(`IQ Option connector HTTP ${res.status}.`) as Error & {
                status?: number;
                nonRetryable?: boolean;
              };
              parseErr.status = res.status;
              parseErr.nonRetryable = true;
              throw parseErr;
            }
            throw new Error('IQ Option connector returned a non-JSON response.');
          }
        }
        if (!res.ok) {
          const msg = String(json.detail || json.error || `Connector HTTP ${res.status}`);
          // Retry once on transient 502/503 (e.g. cold start or momentary busy lock), but do not blindly retry 504 on /connect
          const retryableStatus = isConnect ? res.status === 502 || res.status === 503 : res.status === 502 || res.status === 503 || res.status === 504;
          if (retryableStatus && attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, baseBackoffMs * attempt));
            continue;
          }
          const httpErr = new Error(msg) as Error & { status?: number; nonRetryable?: boolean };
          httpErr.status = res.status;
          httpErr.nonRetryable = true;
          throw httpErr;
        }
        return json as T;
      } catch (err) {
        lastErr = err;
        const tagged = err as Error & { nonRetryable?: boolean; name?: string };
        if (tagged?.nonRetryable) {
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        const isClientTimeout =
          tagged?.name === 'TimeoutError' ||
          tagged?.name === 'AbortError' ||
          /aborted due to timeout|operation was aborted/i.test(msg);
        if (isConnect && isClientTimeout) {
          throw new Error(
            `IQ Option connector timed out during ${path} after ${Math.round(timeoutMs / 1000)}s (broker handshake did not complete in time).`
          );
        }
        const isTransient = /timeout|timed out|abort|econnreset|etimedout|econnrefused|fetch failed|gateway returned http 50[234]|502|503|504/i.test(msg);
        if (!isTransient) {
          throw err;
        }
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, baseBackoffMs * attempt));
          continue;
        }
      }
    }

    const errMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(`IQ connector unreachable or timed out after ${maxAttempts} attempts (${errMsg}).`);
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
      realAccountSupported: cfg.urlValid,
      orderExecutionSupported: false,
      marketDataSupported: cfg.urlValid,
      accountSyncSupported: cfg.urlValid,
      positionsSyncSupported: false,
      historySupported: cfg.urlValid,
      demoOrderPlacementSupported: false,
      liveOrderPlacementSupported: false,
      supportedAssetClasses: ['FOREX', 'CRYPTO', 'BINARY'],
      supportedOrderTypes: ['BINARY_FIXED_EXPIRY'],
      environment: cfg.urlValid ? (ctx?.environment === 'real' ? 'real' : 'demo') : null,
      message: !cfg.configured
        ? 'IQ_CONNECTOR_URL is not set. Configure a private iq-connector instance for Demo or Real diagnostics.'
        : !cfg.urlValid
          ? cfg.warnings[0] || 'IQ_CONNECTOR_URL is malformed.'
          : `IQ Option ${ctx?.environment === 'real' ? 'REAL' : 'PRACTICE'} read-only connector configured (${cfg.targetHost}). Order execution remains locked.`,
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
    const cfg = this.getConfig(ctx);
    const requestedMode = ctx?.environment === 'real' ? 'REAL' : 'PRACTICE';
    const key = `${cfg.url || 'unconfigured'}:${requestedMode}`;
    const existing = this.inflightStatus.get(key);
    if (existing) return existing;

    const promise = this.getStatusInternal(ctx).finally(() => {
      if (this.inflightStatus.get(key) === promise) {
        this.inflightStatus.delete(key);
      }
    });
    this.inflightStatus.set(key, promise);
    return promise;
  }

  private async getStatusInternal(ctx?: BrokerAccountContext): Promise<BrokerStatusSnapshot> {
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
    const requestedMode = ctx?.environment === 'real' ? 'REAL' : 'PRACTICE';
    try {
      const health = await this.requestConnector<{
        connected?: boolean;
        authenticated?: boolean;
        busy?: boolean;
        connectInFlight?: boolean;
        mode?: string;
        accountType?: string;
        modeVerified?: boolean;
        credentialsConfigured?: boolean;
        lastError?: string | null;
      }>('/health', {}, ctx);
      const latencyMs = Date.now() - started;

      let balance: number | null = null;
      let accountType: string | null = health.connected ? health.accountType || health.mode || requestedMode : null;
      let currency: string | null = null;
      let modeVerificationError: string | null = null;
      let accountSyncError: string | null = null;

      if (health.connected && health.authenticated !== false && !health.connectInFlight) {
        try {
          const acct = await this.requestConnector<{
            accountType?: string;
            mode?: string;
            modeVerified?: boolean;
            balance?: number;
            currency?: string;
          }>('/account', {}, ctx);
          const reportedMode = String(acct.accountType || acct.mode || accountType || 'PRACTICE').toUpperCase();
          if (requestedMode === 'REAL' && (acct.modeVerified === false || reportedMode !== 'REAL')) {
            modeVerificationError = `IQ Option connector could not verify REAL account mode (reported ${reportedMode}).`;
            accountType = null;
            balance = null;
          } else {
            balance = toFiniteNumber(acct.balance);
            accountType = reportedMode;
            currency = acct.currency || 'USD';
            if (balance === null) {
              accountSyncError = 'IQ Option connector did not return a valid numeric balance.';
            }
          }
        } catch (acctErr) {
          const msg = acctErr instanceof Error ? acctErr.message : 'IQ Option account sync failed.';
          if (requestedMode === 'REAL') {
            modeVerificationError = msg;
            accountType = null;
            balance = null;
          } else {
            accountSyncError = msg;
            balance = null;
          }
        }
      }

      if (requestedMode === 'REAL' && health.connected && health.modeVerified === false) {
        modeVerificationError =
          modeVerificationError ||
          `IQ Option connector could not verify REAL mode (mode=${health.mode || 'UNVERIFIED'}).`;
      }

      const verifiedConnected = Boolean(health.connected) && health.authenticated !== false && !modeVerificationError;
      const diagnostics: BrokerConnectorDiagnostics = {
        ...baseDiagnostics,
        reachable: true,
        authenticated: verifiedConnected,
        credentialsConfigured:
          typeof health.credentialsConfigured === 'boolean' ? health.credentialsConfigured : null,
        latencyMs,
        lastConnectorError: modeVerificationError || accountSyncError || health.lastError || null,
      };

      const warningSuffix = cfg.warnings.length > 0 ? ` (${cfg.warnings[0]})` : '';
      return {
        ...caps,
        connected: verifiedConnected,
        executionEnabled: false,
        accountType,
        balance,
        equity: balance,
        currency,
        connectorUrlConfigured: true,
        lastCheckedAt: checkedAt,
        message: modeVerificationError
          ? modeVerificationError
          : verifiedConnected
            ? accountSyncError
              ? `Connected to IQ Option connector (${accountType || requestedMode} read-only, ${latencyMs}ms), but balance is unavailable (${accountSyncError}).${warningSuffix}`
              : `Connected to IQ Option connector (${accountType || requestedMode} read-only, ${latencyMs}ms). Order execution locked.${warningSuffix}`
            : health.connectInFlight
              ? `IQ connector reachable (${latencyMs}ms); establishing ${requestedMode} broker session, please wait...${warningSuffix}`
              : health.credentialsConfigured
                ? `IQ connector reachable (${latencyMs}ms); not authenticated (${health.lastError || `click Connect to initiate ${requestedMode} session`}).${warningSuffix}`
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
    const cfg = this.getConfig(ctx);
    const requestedMode = ctx?.environment === 'real' ? 'REAL' : 'PRACTICE';
    const key = `${cfg.url || 'unconfigured'}:${requestedMode}:${(ctx?.credentials.email || 'env').trim().toLowerCase()}`;
    const existing = this.inflightConnect.get(key);
    if (existing) return existing;

    const promise = this.connectInternal(ctx).finally(() => {
      if (this.inflightConnect.get(key) === promise) {
        this.inflightConnect.delete(key);
      }
    });
    this.inflightConnect.set(key, promise);
    return promise;
  }

  private async connectInternal(ctx?: BrokerAccountContext) {
    const requestedMode = ctx?.environment === 'real' ? 'REAL' : 'PRACTICE';
    const creds = ctx?.credentials || {};
    const res = await this.requestConnector<{
      connected?: boolean;
      accountType?: string;
      mode?: string;
      modeVerified?: boolean;
      detail?: string;
    }>(
      '/connect',
      {
        method: 'POST',
        body: JSON.stringify({
          email: creds.email || undefined,
          password: creds.apiSecret || undefined,
          mode: requestedMode,
        }),
      },
      ctx
    );

    const reportedMode = String(res.accountType || res.mode || '').toUpperCase();
    if (
      requestedMode === 'REAL' &&
      (res.modeVerified === false || (reportedMode && reportedMode !== 'REAL'))
    ) {
      return {
        connected: false,
        accountType: reportedMode || null,
        balance: null,
        equity: null,
        currency: null,
        externalAccountId: null,
        message:
          res.detail ||
          `IQ Option connector could not verify REAL account mode (reported ${reportedMode || 'UNVERIFIED'}); refusing to mask PRACTICE as REAL.`,
      };
    }

    let balance: number | null = null;
    let currency: string | null = 'USD';
    let confirmedAccountType = reportedMode || requestedMode;
    let balanceWarning: string | null = null;
    if (res.connected) {
      try {
        const acct = await this.getBalance(ctx);
        balance = toFiniteNumber(acct.balance);
        currency = acct.currency;
        confirmedAccountType = acct.accountType;
      } catch (err) {
        if (requestedMode === 'REAL') {
          return {
            connected: false,
            accountType: null,
            balance: null,
            equity: null,
            currency: null,
            externalAccountId: null,
            message: err instanceof Error ? err.message : 'IQ Option REAL mode balance verification failed.',
          };
        }
        balance = null;
        balanceWarning = err instanceof Error ? err.message : 'Balance unavailable from broker.';
      }
    }
    return {
      connected: Boolean(res.connected),
      accountType: confirmedAccountType,
      balance,
      equity: balance,
      currency,
      externalAccountId: requestedMode === 'REAL' ? 'iq-real' : 'iq-practice',
      message: res.connected
        ? balanceWarning
          ? `Authenticated with IQ Option connector in ${confirmedAccountType} read-only mode, but balance could not be read (${balanceWarning}).`
          : `Authenticated with IQ Option connector in ${confirmedAccountType} read-only mode. Order placement remains disabled.`
        : res.detail || 'IQ Option connector did not confirm an active session.',
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
    const requestedMode = ctx?.environment === 'real' ? 'REAL' : 'PRACTICE';
    const acct = await this.requestConnector<{
      balance?: number;
      accountType?: string;
      mode?: string;
      modeVerified?: boolean;
      currency?: string;
      source?: string;
    }>('/account', {}, ctx);
    const reportedMode = String(acct.accountType || acct.mode || 'PRACTICE').toUpperCase();
    if (requestedMode === 'REAL' && (acct.modeVerified === false || reportedMode !== 'REAL')) {
      throw new Error(
        `IQ Option REAL mode verification failed (connector reported ${reportedMode}). Refusing to treat PRACTICE balance as REAL.`
      );
    }
    const bal = toFiniteNumber(acct.balance);
    if (bal === null) {
      throw new Error('IQ Option connector returned a missing or non-numeric account balance.');
    }
    return {
      balance: bal,
      equity: bal,
      accountType: reportedMode,
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
    const clean = symbol.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    try {
      const res = await this.requestConnector<BrokerQuote>(`/price/${encodeURIComponent(clean)}`, {}, ctx);
      const last = toFiniteNumber(res.last);
      if (last !== null && last > 0) {
        return {
          symbol: res.symbol || clean,
          bid: toFiniteNumber(res.bid),
          ask: toFiniteNumber(res.ask),
          last,
          spread: toFiniteNumber(res.spread),
          time: toFiniteNumber(res.time),
          source: res.source || 'IQ_OPTION_UNOFFICIAL',
          note: res.note,
        };
      }
    } catch (err) {
      const tagged = err as Error & { status?: number; nonRetryable?: boolean };
      const msg = err instanceof Error ? err.message : String(err);
      if (
        tagged?.nonRetryable &&
        tagged.status !== 404 &&
        tagged.status !== 405
      ) {
        throw err;
      }
      if (/IQ_CONNECTOR_URL|unreachable or timed out after/i.test(msg)) {
        throw err;
      }
    }

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

  async getCandles(
    symbol: string,
    intervalSeconds = 60,
    count = 100,
    ctx?: BrokerAccountContext
  ): Promise<{ candles: BrokerCandle[]; source: string; note?: string }> {
    const clean = symbol.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    const safeInterval = Math.max(5, Math.min(86400, Math.round(Number(intervalSeconds) || 60)));
    const safeCount = Math.max(1, Math.min(500, Math.round(Number(count) || 100)));
    const res = await this.requestConnector<{ candles?: BrokerCandle[]; source?: string; note?: string }>(
      '/candles',
      {
        method: 'POST',
        body: JSON.stringify({ symbol: clean, interval: safeInterval, count: safeCount }),
      },
      ctx
    );
    const rawCandles = Array.isArray(res.candles) ? res.candles : [];
    const validCandles: BrokerCandle[] = [];
    for (const c of rawCandles) {
      if (!c || typeof c !== 'object') continue;
      const time = toFiniteNumber(c.time);
      const open = toFiniteNumber(c.open);
      const high = toFiniteNumber(c.high);
      const low = toFiniteNumber(c.low);
      const close = toFiniteNumber(c.close);
      const vol = toFiniteNumber(c.volume);
      if (
        time === null ||
        time <= 0 ||
        open === null ||
        open <= 0 ||
        high === null ||
        high <= 0 ||
        low === null ||
        low <= 0 ||
        close === null ||
        close <= 0
      ) {
        continue;
      }
      validCandles.push({
        time: Math.trunc(time),
        open,
        high,
        low,
        close,
        volume: vol !== null && vol >= 0 ? vol : 0,
      });
    }
    if (validCandles.length === 0) {
      throw new Error(`IQ Option connector returned no valid candlestick data for ${clean}.`);
    }
    return {
      candles: validCandles,
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
    const requestedMode = ctx?.environment === 'real' ? 'REAL' : 'PRACTICE';
    const res = await this.requestConnector<BrokerTradeHistoryResult & { mode?: string; modeVerified?: boolean }>(
      '/history',
      {},
      ctx
    );
    if (
      requestedMode === 'REAL' &&
      (res.modeVerified === false || (res.mode && String(res.mode).toUpperCase() !== 'REAL'))
    ) {
      throw new Error(
        `IQ Option REAL history verification failed (connector reported ${res.mode || 'UNVERIFIED'}).`
      );
    }
    return {
      supported: Boolean(res.supported),
      trades: Array.isArray(res.trades) ? res.trades : [],
      note: res.note || `Retrieved from IQ Option connector (${requestedMode}).`,
    };
  }
}
