import { MockAgent } from 'undici';
import { SignJWT } from 'jose';

import { MotoGPClient, type MotoGPClientOptions } from '../src/client';

const KEY = new TextEncoder().encode('test-secret-test-secret-test-secret');

/** An access token like the real `DAT`, signed with a test key. `expiresIn` is in seconds from now. */
export const signToken = (expiresIn = 3600) =>
  new SignJWT({ scopes: [], entitlements: { mgp: ['Registered'] }, roles: ['ROLE_USER'] })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience('b32ca14f-0709-495a-9184-8bd848cf7e6b')
    .setSubject('00000000-0000-4000-8000-000000000000')
    .setJti('jti')
    .setIssuedAt()
    .setNotBefore(0)
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn)
    .sign(KEY);

export const tokenResponse = async (expiresIn = 3600, refresh = 'refresh-1') => ({
  token_type: 'Bearer',
  expires_in: expiresIn,
  access_token: await signToken(expiresIn),
  refresh_token: refresh,
  issued_token_type: null,
});

export const JSON_HEADERS = { 'content-type': 'application/json' };

export const API = 'https://api.pulselive.motogp.com';
export const ACCOUNT = 'https://api.motogp.com';
export const PREFIX = '/motogp/v1';

export const mockAgent = () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  return agent;
};

export const clientWith = async (agent: MockAgent, options: MotoGPClientOptions = {}) =>
  MotoGPClient.create({ dispatcher: agent, ...options });
