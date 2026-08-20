import React from "react";
import Link from "next/link";
import { VISIBLE_SOCIAL_LINKS } from "@/lib/social";

type FooterLinkItem = {
  label: string;
  href: string;
};

const shopLinks: FooterLinkItem[] = [
  { label: "ALL", href: "/item" },
  { label: "TOPS", href: "/item?category=TOPS" },
  { label: "BOTTOMS", href: "/item?category=BOTTOMS" },
  { label: "OUTERWEAR", href: "/item?category=OUTERWEAR" },
  { label: "ACCESSORIES", href: "/item?category=ACCESSORIES" },
];

const informationLinks: FooterLinkItem[] = [
  { label: "LOOK", href: "/look" },
  { label: "NEWS", href: "/news" },
  { label: "STOCKIST", href: "/stockist" },
  { label: "ABOUT", href: "/about" },
  { label: "CONTACT", href: "/contact" },
];

const FooterLinkList = ({
  title,
  links,
}: {
  title: string;
  links: FooterLinkItem[];
}) => (
  <div className="footer-category-title-space">
    <h4 className="footer-category-title font-brand">{title}</h4>
    <ul className="space-y-2.75 sm:space-y-3.25 md:space-y-3.75">
      {links.map((link) => (
        <li key={link.label}>
          <Link className="footer-link" href={link.href}>
            {link.label}
          </Link>
        </li>
      ))}
    </ul>
  </div>
);

const Footer = () => {
  return (
    // site-chrome: 管理画面のフォント一括指定から除外し、他ページと同じ表示にする。
    <footer className="site-chrome relative z-30 bg-black text-white pt-7 sm:pt-8.5 md:pt-10.5 pb-2.5 sm:pb-3.25 md:pb-4">
      <div className="px-3.25 sm:px-4 md:px-5.25 lg:px-8.5 xl:px-13.75 max-w-7xl mx-auto">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3.25 sm:gap-3.5 md:gap-4.5 lg:gap-6.5 mb-7 sm:mb-8.5 md:mb-10.5">
          <div className="col-span-2 md:col-span-1 mb-5.25 sm:mb-6.5 md:mb-0">
            <h3 className="footer-brand-title tracking-tight">
              Le Fil des Heures
            </h3>
          </div>

          <FooterLinkList title="SHOP" links={shopLinks} />
          <FooterLinkList title="INFORMATION" links={informationLinks} />

          <div className="footer-category-title-space mt-5.25 sm:mt-6.5 md:mt-0">
            <h4 className=" footer-category-title font-brand">FOLLOW US</h4>
            <div className="flex gap-3 sm:gap-4">
              {VISIBLE_SOCIAL_LINKS.map((social) => (
                <a
                  key={social.key}
                  href={social.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={social.label}
                  className="footer-social-link"
                >
                  <i
                    className={`${social.iconClass} footer-social-icon`}
                    aria-hidden="true"
                  ></i>
                </a>
              ))}
            </div>
          </div>
        </div>
        <div className="pt-2.5 sm:pt-3.25 md:pt-4 border-t border-white/25 flex flex-col md:flex-row justify-between items-center gap-1.5 sm:gap-2 md:gap-2.5">
          <p className="footer-legal-copy">
            © 2026 Le Fil des Heures. All rights reserved.
          </p>
          <div className="flex items-center gap-2.5 sm:gap-3.25 md:gap-4">
            <a className="footer-legal-link" href="/privacy">
              Privacy Policy
            </a>
            <a className="footer-legal-link" href="/terms">
              Terms of Service
            </a>
            <a className="footer-legal-link" href="/legal">
              Legal Notice
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
