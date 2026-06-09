import "./List.css";
import Link from "next/link";
import Image from "next/image";
import type { ListProps } from "./List_types";

export function List<T>({
  items,
  itemKey,
  className,
  size = "md",
  ...props
}: ListProps<T>) {
  if (props.variant !== "showcase") {
    return (
      <ul data-ui-list="true" data-ui-list-size={size} className={className}>
        {items.map((item, index) => (
          <li key={itemKey ? itemKey(item, index) : index} data-list-item="">
            {props.renderItem(item, index)}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <ul
      data-ui-list="true"
      data-ui-list-size={size}
      data-ui-list-variant="showcase"
      className={className}
    >
      {items.map((item, index) => {
        const key = itemKey ? itemKey(item, index) : index;

        const rowInner = (
          <>
            <div data-list-left="">
              <div data-list-preview="">
                {props.getImage ? (
                  <Image
                    src={props.getImage(item) || "/placeholder.png"}
                    alt={props.getName(item)}
                    width={96}
                    height={144}
                    sizes="(min-width: 1024px) 64px, 40px"
                    loading="eager"
                    className="h-full w-auto object-contain"
                  />
                ) : (
                  <div data-list-placeholder="">
                    <i
                      data-list-placeholder-icon=""
                      className="ri-image-line"
                      aria-hidden="true"
                    />
                  </div>
                )}
              </div>
              <div data-list-info="">
                <p data-list-title="">{props.getName(item)}</p>
                <p data-list-category="">{props.getCategory(item)}</p>
              </div>
            </div>
            <div data-list-right="">
              <span data-list-price="">{props.getPrice(item)}</span>
              <span data-list-chevron="" aria-hidden="true">
                <i className="ri-arrow-right-s-line" />
              </span>
            </div>
          </>
        );

        return (
          <li key={key} data-list-item="">
            {props.getHref ? (
              <Link
                href={props.getHref(item)}
                data-list-showcase-row=""
              >
                {rowInner}
              </Link>
            ) : (
              <div data-list-showcase-row="">{rowInner}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
