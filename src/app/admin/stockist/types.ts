export type StockistStatus = 'private' | 'published';

export type StockistFormValues = {
  name: string;
  address: string;
  phone: string;
  time: string;
  holiday: string;
  status: StockistStatus;
};

export type StockistResponse = {
  id: number;
  name: string;
  address: string;
  phone: string;
  time: string;
  holiday: string;
  status: StockistStatus;
};
