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
    <ul className="space-y-[8px] md:space-y-[9px] lg:space-y-[10px]">
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
    <footer className="bg-black text-white pt-[34px] sm:pt-[42px] md:pt-[55px] pb-[13px] sm:pb-[16px] md:pb-[21px]">
      <div className="px-[13px] sm:px-[16px] md:px-[21px] lg:px-[34px] xl:px-[55px] max-w-[1280px] mx-auto">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-[13px] sm:gap-[16px] md:gap-[21px] lg:gap-[34px] mb-[21px] sm:mb-[26px] md:mb-[34px]">
          <div className="col-span-2 md:col-span-1">
            <h3 className="footer-brand-title mb-[8px] sm:mb-[10px] md:mb-[13px] tracking-tight">Le Fil des Heures</h3>
            <p className="footer-brand-theme">時を紡ぐニュートラルモードな日常着</p>
          </div>

          <FooterLinkList title="SHOP" links={shopLinks} />
          <FooterLinkList title="INFORMATION" links={informationLinks} />

          <div className="footer-category-title-space">
            <h4 className=" footer-category-title font-brand">FOLLOW US</h4>
            <div className="flex gap-4">
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
        <div className="pt-[13px] sm:pt-[16px] md:pt-[21px] border-t border-white/10 flex flex-col md:flex-row justify-between items-center gap-[8px] sm:gap-[10px] md:gap-[13px]">
          <p className="footer-legal-copy">© 2026 Le Fil des Heures. All rights reserved.</p>
          <div className="flex items-center gap-[13px] sm:gap-[16px] md:gap-[21px]">
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