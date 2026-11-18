"""Local, opt-in IQ Option connectivity probe. No orders are placed.

Unofficial community adapter; do not use with real funds without independently
verifying broker permission, compatibility and account security.
"""
import argparse
import getpass
import json
import os
import sys


def emit(**kwargs):
    print(json.dumps(kwargs, default=str))


def main():
    parser = argparse.ArgumentParser(description='IQ Option read-only connectivity probe')
    parser.add_argument('--environment', choices=['PRACTICE', 'REAL'], default='PRACTICE')
    parser.add_argument('--symbol', default='EURUSD')
    parser.add_argument('--candles', action='store_true', help='Fetch recent candles, if supported')
    args = parser.parse_args()
    if args.environment == 'REAL' and os.environ.get('NOVATRADE_ALLOW_REAL_READONLY') != 'YES':
        emit(ok=False, error='REAL read-only probe locked. Set NOVATRADE_ALLOW_REAL_READONLY=YES after reviewing risks.')
        return 2
    try:
        from iqoptionapi.stable_api import IQ_Option
    except ImportError:
        emit(ok=False, error='Unofficial iqoptionapi is not installed. See connector/README.md')
        return 2
    email = os.getenv('IQOPTION_EMAIL') or input('IQ Option email (local terminal only): ').strip()
    password = os.getenv('IQOPTION_PASSWORD') or getpass.getpass('IQ Option password (not displayed): ')
    if not email or not password:
        emit(ok=False, error='Missing credentials')
        return 2
    try:
        api = IQ_Option(email, password)
        connected, reason = api.connect()
        if not connected:
            emit(ok=False, connected=False, error='Login failed or requires additional verification', detail=str(reason))
            return 1
        api.change_balance(args.environment)
        result = {'ok': True, 'connected': True, 'environment': args.environment,
                  'balance': api.get_balance(), 'currency': 'broker account currency; verify in platform',
                  'trade_execution': 'DISABLED', 'source': 'unofficial community connector'}
        if args.candles:
            import time
            raw = api.get_candles(args.symbol, 60, 5, time.time())
            result['symbol'] = args.symbol
            result['candles'] = [{'from': c.get('from'), 'open': c.get('open'),
                                  'close': c.get('close'), 'min': c.get('min'),
                                  'max': c.get('max')} for c in (raw or [])]
            result['warning'] = 'Historical candles may be delayed; not validated for live trading.'
        emit(**result)
        return 0
    except Exception as exc:
        emit(ok=False, error='Connector failed; protocol may have changed', detail=type(exc).__name__)
        return 1
    finally:
        password = None


if __name__ == '__main__':
    sys.exit(main())
