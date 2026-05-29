import React from 'react';
import Link from 'next/link';

type FooterLinkItem = {
  label: string;
  href: string;
};

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
    <ul className="space-y-[6px] sm:space-y-[7px] md:space-y-[8px]">
      {links.map((link) => (
        <li key={link.label}>
          <Link className='footer-link' href={link.href}>
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
        <div className="grid grid-cols-2 md:grid-cols-4 gap-[13px] sm:gap-[14px] md:gap-[18px] lg:gap-[26px] mb-[18px] sm:mb-[21px] md:mb-[26px]">
          <div className="col-span-2 md:col-span-1">
            <h3 className="footer-brand-title mb-[6px] sm:mb-[8px] md:mb-[10px] tracking-tight">Le Fil des Heures</h3>
            <p className="footer-brand-theme">時を紡ぐニュートラルモードな日常着</p>
          </div>

          <FooterLinkList title="SHOP" links={shopLinks} />
          <FooterLinkList title="INFORMATION" links={informationLinks} />

          <div className="footer-category-title-space">
            <h4 className=" footer-category-title font-brand">FOLLOW US</h4>
            <div className="flex gap-3 sm:gap-4">
              <a
                href="#"
                className="footer-social-link"
              >
                <i className="ri-instagram-line footer-social-icon"></i>
              </a>
              <a
                href="#"
                className="footer-social-link"
              >
                <i className="ri-facebook-line footer-social-icon"></i>
              </a>
              <a
                href="#"
                className="footer-social-link"
              >
                <i className="ri-twitter-x-line footer-social-icon"></i>
              </a>
            </div>
          </div>
        </div>
        <div className="pt-[10px] sm:pt-[13px] md:pt-[16px] border-t border-white/10 flex flex-col md:flex-row justify-between items-center gap-[6px] sm:gap-[8px] md:gap-[10px]">
          <p className="footer-legal-copy">© 2026 Le Fil des Heures. All rights reserved.</p>
          <div className="flex items-center gap-[10px] sm:gap-[13px] md:gap-[16px]">
            <a className="footer-legal-link" href="/privacy">
              Privacy Policy
            </a>
            <a className="footer-legal-link" href="/terms">
              Terms of Service
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;