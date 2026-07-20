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
    <ul className="space-y-[11px] sm:space-y-[13px] md:space-y-[15px]">
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
    <footer className="bg-black text-white pt-[28px] sm:pt-[34px] md:pt-[42px] pb-[10px] sm:pb-[13px] md:pb-[16px]">
      <div className="px-[13px] sm:px-[16px] md:px-[21px] lg:px-[34px] xl:px-[55px] max-w-[1280px] mx-auto">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-[13px] sm:gap-[14px] md:gap-[18px] lg:gap-[26px] mb-[28px] sm:mb-[34px] md:mb-[42px]">
          <div className="col-span-2 md:col-span-1 mb-[21px] sm:mb-[26px] md:mb-0">
            <h3 className="footer-brand-title tracking-tight">
              Le Fil des Heures
            </h3>
          </div>

          <FooterLinkList title="SHOP" links={shopLinks} />
          <FooterLinkList title="INFORMATION" links={informationLinks} />

          <div className="footer-category-title-space mt-[21px] sm:mt-[26px] md:mt-0">
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
        <div className="pt-[10px] sm:pt-[13px] md:pt-[16px] border-t border-white/25 flex flex-col md:flex-row justify-between items-center gap-[6px] sm:gap-[8px] md:gap-[10px]">
          <p className="footer-legal-copy">
            © 2026 Le Fil des Heures. All rights reserved.
          </p>
          <div className="flex items-center gap-[10px] sm:gap-[13px] md:gap-[16px]">
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
