import '../test/storagePolyfill';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppSettings } from '../types';
import { hasConfiguredModel, hasWritingModel } from '../ai/models';
import { useSettings } from './settings';

const empty: AppSettings = {
  providers: [],
  proseModel: null,
  utilityModel: null,
  imageModel: null,
  matureDefault: true,
  defaultVisibility: 'private'
};

describe('addProvider', () => {
  beforeEach(() => {
    localStorage.removeItem('small-worlds-settings');
    useSettings.setState({ ...empty, vaultPersistError: '' });
  });

  afterEach(() => {
    localStorage.removeItem('small-worlds-settings');
    useSettings.setState({ ...empty, vaultPersistError: '' });
  });

  it('picks the first suggested model when prose and utility are unset', () => {
    useSettings.getState().addProvider({
      id: 'p1',
      kind: 'openai',
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test'
    });
    const s = useSettings.getState();
    expect(s.proseModel).toEqual({ providerId: 'p1', model: 'gpt-5' });
    expect(s.utilityModel).toEqual({ providerId: 'p1', model: 'gpt-5' });
  });

  it('does not invent a model id when the preset has no suggestions', () => {
    useSettings.getState().addProvider({
      id: 'ollama1',
      kind: 'openai',
      label: 'Ollama (local)',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: ''
    });
    const s = useSettings.getState();
    expect(s.proseModel).toBeNull();
    expect(s.utilityModel).toBeNull();
  });

  it('leaves existing model refs in place', () => {
    useSettings.setState({
      proseModel: { providerId: 'old', model: 'keep-me' },
      utilityModel: { providerId: 'old', model: 'keep-me' }
    });
    useSettings.getState().addProvider({
      id: 'p2',
      kind: 'openai',
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test'
    });
    expect(useSettings.getState().proseModel).toEqual({ providerId: 'old', model: 'keep-me' });
    expect(useSettings.getState().utilityModel).toEqual({ providerId: 'old', model: 'keep-me' });
  });
});

describe('hasWritingModel', () => {
  beforeEach(() => {
    localStorage.removeItem('small-worlds-settings');
    useSettings.setState({ ...empty, vaultPersistError: '' });
  });

  afterEach(() => {
    localStorage.removeItem('small-worlds-settings');
    useSettings.setState({ ...empty, vaultPersistError: '' });
  });

  const provider = {
    id: 'p1', kind: 'openai' as const, label: 'Test',
    baseUrl: 'https://example.com/v1', apiKey: 'k'
  };

  it('is false when only a utility model is set', () => {
    useSettings.setState({
      providers: [provider],
      proseModel: null,
      utilityModel: { providerId: 'p1', model: 'util' }
    });
    expect(hasWritingModel()).toBe(false);
    expect(hasConfiguredModel()).toBe(true);
  });

  it('is true when a writing model is set', () => {
    useSettings.setState({
      providers: [provider],
      proseModel: { providerId: 'p1', model: 'writer' },
      utilityModel: null
    });
    expect(hasWritingModel()).toBe(true);
  });
});
