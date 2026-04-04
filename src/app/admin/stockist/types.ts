import { StockistType } from '@/features/stockist/types';

export type StockistStatus = 'private' | 'published';

export type StockistFormValues = {
  type: StockistType;
  name: string;
  address: string;
  phone: string;
  time: string;
  holiday: string;
  status: StockistStatus;
};

export type StockistResponse = {
  id: number;
  type: StockistType;
  name: string;
  address: string;
  phone: string;
  time: string;
  holiday: string;
  status: StockistStatus;
};
