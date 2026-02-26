import { Card } from '@/app/components/ui/Card';
import { TagLabel } from '@/app/components/ui/TagLabel';

type StockistType = 'FLAGSHIP STORE' | 'STORE' | 'SELECT SHOP';

type Stockist = {
  type: StockistType;
  name: string;
  address: string;
  phone: string;
  time: string;
  holiday: string;
};

const stockists: Stockist[] = [
  {
    type: 'FLAGSHIP STORE',
    name: 'Le Fil des Heures Aoyama',
    address: '東京都港区南青山3-14-15',
    phone: '03-1234-5678',
    time: '11:00 - 20:00',
    holiday: '水曜定休',
  },
  {
    type: 'STORE',
    name: 'Le Fil des Heures Ginza',
    address: '東京都中央区銀座6-10-1',
    phone: '03-2345-6789',
    time: '11:00 - 20:00',
    holiday: '不定休',
  },
  {
    type: 'STORE',
    name: 'Le Fil des Heures Osaka',
    address: '大阪府大阪市北区梅田2-5-25',
    phone: '06-3456-7890',
    time: '11:00 - 20:00',
    holiday: '水曜定休',
  },
  {
    type: 'SELECT SHOP',
    name: 'Maison de Mode Tokyo',
    address: '東京都渋谷区神宮前5-10-1',
    phone: '03-4567-8901',
    time: '12:00 - 20:00',
    holiday: '月曜定休',
  },
  {
    type: 'SELECT SHOP',
    name: 'Atelier Blanc Kyoto',
    address: '京都府京都市中京区烏丸通三条上ル',
    phone: '075-567-8901',
    time: '11:00 - 19:00',
    holiday: '火曜定休',
  },
  {
    type: 'SELECT SHOP',
    name: 'Minimal Store Fukuoka',
    address: '福岡県福岡市中央区天神2-8-34',
    phone: '092-678-9012',
    time: '11:00 - 20:00',
    holiday: '不定休',
  },
];

export default function StockistPage() {
  return (
    <main className="pt-32 pb-20 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-12">
          {stockists.map((shop) => (
            <Card key={shop.name} className="border-black/10 p-8 hover:border-black transition-colors duration-300">
              <div className="mb-4">
                <TagLabel className="inline-block mb-4 font-brand">{shop.type}</TagLabel>
                <h2 className="text-2xl text-black mb-6 font-display">{shop.name}</h2>
              </div>
              <div className="space-y-3">
                <div className="flex items-start">
                  <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-map-pin-line text-lg text-black" /></div>
                  <p className="text-sm text-[#474747] font-brand">{shop.address}</p>
                </div>
                <div className="flex items-center">
                  <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-phone-line text-lg text-black" /></div>
                  <p className="text-sm text-[#474747] font-brand">{shop.phone}</p>
                </div>
                <div className="flex items-center">
                  <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-time-line text-lg text-black" /></div>
                  <p className="text-sm text-[#474747] font-brand">{shop.time}</p>
                </div>
                <div className="flex items-center">
                  <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-calendar-line text-lg text-black" /></div>
                  <p className="text-sm text-[#474747] font-brand">{shop.holiday}</p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </main>
  );
}