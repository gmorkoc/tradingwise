import axios from 'axios';

export interface FearGreedEntry {
  value: number;
  classification: string;
  timestamp: number;
}

export interface FearGreedData {
  current: FearGreedEntry;
  yesterday: FearGreedEntry;
  lastWeek: FearGreedEntry;
}

const fngApi = axios.create({
  baseURL: 'https://api.alternative.me',
  timeout: 8000,
});

function parse(d: { value: string; value_classification: string; timestamp: string }): FearGreedEntry {
  return {
    value: parseInt(d.value, 10),
    classification: d.value_classification,
    timestamp: parseInt(d.timestamp, 10),
  };
}

export async function fetchFearGreed(): Promise<FearGreedData | null> {
  try {
    const res = await fngApi.get('/fng/?limit=8&format=json');
    const data = res.data?.data;
    if (!Array.isArray(data) || data.length < 2) return null;
    return {
      current:   parse(data[0]),
      yesterday: parse(data[1]),
      lastWeek:  parse(data[Math.min(7, data.length - 1)]),
    };
  } catch {
    return null;
  }
}
