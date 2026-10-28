import { describe, it, expect, beforeEach } from 'vitest';
import { getLocalConfig } from './api';

const CONFIG_KEY = 'audiobook_tagger_config';
const setConfig = (cfg) => localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));

describe('getLocalConfig — legacy AI config migration (PR #1)', () => {
  beforeEach(() => localStorage.clear());

  it('keeps a legacy Claude selection on the Anthropic provider', () => {
    setConfig({ ai_model: 'claude-haiku-4-5', ai_base_url: 'https://api.anthropic.com' });
    const cfg = getLocalConfig();
    expect(cfg.ai_provider).toBe('anthropic');
    expect(cfg.openai_base_url).toBe('https://api.openai.com');
    expect(cfg.anthropic_base_url).toBe('https://api.anthropic.com');
  });

  it('keeps a legacy OpenAI selection on the OpenAI provider', () => {
    setConfig({ ai_model: 'gpt-5-mini', ai_base_url: 'https://api.openai.com' });
    const cfg = getLocalConfig();
    expect(cfg.ai_provider).toBe('openai');
    expect(cfg.openai_base_url).toBe('https://api.openai.com');
  });

  it('carries a custom legacy base URL over to openai_base_url', () => {
    setConfig({ ai_model: 'gpt-5-mini', ai_base_url: 'https://llm.example.com' });
    expect(getLocalConfig().openai_base_url).toBe('https://llm.example.com');
  });

  it('respects an explicitly saved provider', () => {
    setConfig({ ai_model: 'my-proxy-model', ai_provider: 'anthropic' });
    expect(getLocalConfig().ai_provider).toBe('anthropic');
  });

  it('defaults a fresh install to OpenAI', () => {
    expect(getLocalConfig().ai_provider).toBe('openai');
  });
});
