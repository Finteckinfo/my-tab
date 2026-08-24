import pino from 'pino';
import * as stream from 'stream';

describe('LoggerModule Redaction', () => {
  it('should redact sensitive keys from objects', () => {
    let output = '';
    const dest = new stream.Writable({
      write(chunk, enc, cb) {
        output += chunk.toString();
        cb();
      }
    });

    const logger = pino({
      redact: {
        paths: [
          '*.phone',
          '*.phoneNumber',
          '*.msisdn',
          '*.otp',
          '*.privateKey',
          '*.mnemonic',
          '*.seed',
          'phone',
          'phoneNumber',
          'msisdn',
          'otp',
          'privateKey',
          'mnemonic',
          'seed',
        ],
        censor: '[REDACTED]',
      },
    }, dest);
    
    logger.info({
      phone: '+1234567890',
      phoneNumber: '+0987654321',
      msisdn: '447700900000',
      otp: '123456',
      privateKey: '0xabc123',
      mnemonic: 'test test test',
      seed: 'seed123',
      safeKey: 'safeValue'
    }, 'Testing redaction');

    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('+1234567890');
    expect(output).not.toContain('+0987654321');
    expect(output).not.toContain('447700900000');
    expect(output).not.toContain('123456');
    expect(output).not.toContain('0xabc123');
    expect(output).not.toContain('test test test');
    expect(output).not.toContain('seed123');
    expect(output).toContain('safeValue');
  });
});
