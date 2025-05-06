import Image from "next/image";

type Item = {
  id: number;
  name: string;
  imageUrl: string;
};

type ItemProps = {
  items: Item[];
};

const ItemGrid: React.FC<ItemProps> = ({ items }) => {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-5 gap-1 w-full">
      {items.map((item) => (
        <div key={item.id} className="flex flex-col items-start">
          <div className="w-full aspect-[3/4] relative">
            <Image
              src={item.imageUrl}
              alt={item.name}
              fill
              className="object-cover"
            />
          </div>
          {/* <p className="mt-2 mb-12 text-sm text-left">{item.name}</p> */}
        </div>
      ))}
    </div>
  );
};

export default ItemGrid;