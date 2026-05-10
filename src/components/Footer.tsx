import React from 'react';
import Link from 'next/link';

type FooterLinkItem = {
  label: string;
  href: string;
};

const FOOTER_LINK_CLASS = 'block text-[10px] sm:text-[11px] md:text-[12px] lg:text-[13px] leading-[1.2] text-white/70 hover:text-white transition-colors cursor-pointer';

const shopLinks: FooterLinkItem[] = [
  { label: 'ALL', href: '/item' },
  { label: 'TOPS', href: '/item' },
  { label: 'BOTTOMS', href: '/item' },
  { label: 'OUTERWEAR', href: '/item' },
  { label: 'ACCESSORIES', href: '/item' },
];

const informationLinks: FooterLinkItem[] = [
  { label: 'ABOUT', href: '/about' },
  { label: 'LOOK', href: '/look' },
  { label: 'NEWS', href: '/news' },
  { label: 'STOCKIST', href: '/stockist' },
  { label: 'CONTACT', href: '/contact' },
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
    <ul className="space-y-[8px] md:space-y-[9px] lg:space-y-[10px]">
      {links.map((link) => (
        <li key={link.label}>
          <Link className={FOOTER_LINK_CLASS} href={link.href}>
            {link.label}
          </Link>
        </li>
      ))}
    </ul>
  </div>
);

const Footer = () => {
  return (
    <footer className="bg-black text-white pt-[34px] sm:pt-[42px] md:pt-[55px] pb-[13px] sm:pb-[16px] md:pb-[21px]">
      <div className="px-[13px] sm:px-[16px] md:px-[21px] lg:px-[34px] xl:px-[55px] max-w-[1280px] mx-auto">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-[13px] sm:gap-[16px] md:gap-[21px] lg:gap-[34px] mb-[21px] sm:mb-[26px] md:mb-[34px]">
          <div className="col-span-2 md:col-span-1">
            <h3 className="text-[16px] sm:text-[17px] md:text-[18px] lg:text-[20px] mb-[8px] sm:mb-[10px] md:mb-[13px] tracking-tight">Le Fil des Heures</h3>
            <p className="text-[10px] sm:text-[11px] text-white/70 leading-relaxed">時を紡ぐニュートラルモードな日常着</p>
          </div>

          <FooterLinkList title="SHOP" links={shopLinks} />
          <FooterLinkList title="INFORMATION" links={informationLinks} />

          <div className="footer-category-title-space">
            <h4 className=" footer-category-title font-brand">FOLLOW US</h4>
            <div className="flex gap-4">
              <a
                href="#"
                className="w-10 h-10 flex items-center justify-center border border-white hover:bg-white hover:text-black transition-all duration-300 cursor-pointer"
              >
                <i className="ri-instagram-line text-xl"></i>
              </a>
              <a
                href="#"
                className="w-10 h-10 flex items-center justify-center border border-white hover:bg-white hover:text-black transition-all duration-300 cursor-pointer"
              >
                <i className="ri-facebook-line text-xl"></i>
              </a>
              <a
                href="#"
                className="w-10 h-10 flex items-center justify-center border border-white hover:bg-white hover:text-black transition-all duration-300 cursor-pointer"
              >
                <i className="ri-twitter-x-line text-xl"></i>
              </a>
            </div>
          </div>
        </div>
        <div className="pt-[13px] sm:pt-[16px] md:pt-[21px] border-t border-white/10 flex flex-col md:flex-row justify-between items-center gap-[8px] sm:gap-[10px] md:gap-[13px]">
          <p className="text-[9px] sm:text-[12px] text-white/50">© 2026 Le Fil des Heures. All rights reserved.</p>
          <div className="flex items-center gap-[13px] sm:gap-[16px] md:gap-[21px]">
            <a className="text-[9px] sm:text-[12px] text-white/50 hover:text-white transition-colors duration-300 cursor-pointer" href="/privacy">
              Privacy Policy
            </a>
            <a className="text-[9px] sm:text-[12px] text-white/50 hover:text-white transition-colors duration-300 cursor-pointer" href="/terms">
              Terms of Service
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;