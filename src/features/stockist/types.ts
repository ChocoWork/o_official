export type StockistStatus = 'private' | 'published';

export type StockistRecord = {
  id: number;
  name: string;
  address: string;
  phone: string;
  time: string;
  holiday: string;
  status: StockistStatus;
  created_at?: string;
  updated_at?: string;
};

export type PublicStockist = {
  name: string;
  address: string;
  phone: string;
  time: string;
  holiday: string;
};