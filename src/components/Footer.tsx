import React from 'react';
import Link from 'next/link';

type FooterLinkItem = {
  label: string;
  href: string;
};

const FOOTER_LINK_CLASS = 'text-sm text-white/70 hover:text-white transition-colors duration-300 cursor-pointer';

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
  <div>
    <h4 className="text-sm tracking-widest mb-4 font-display">{title}</h4>
    <ul className="space-y-2">
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
    <footer className="bg-black text-white py-8 px-6 lg:px-12 w-full font-brand">
      <div className="w-full">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-12 mb-8 w-full">
          <div>
            <h3 className="text-2xl mb-6 tracking-tight font-display">Le Fil des Heures</h3>
            <p className="text-sm text-white/70 leading-relaxed">時を紡ぐニュートラルモードな日常着</p>
          </div>

          <FooterLinkList title="SHOP" links={shopLinks} />
          <FooterLinkList title="INFORMATION" links={informationLinks} />

          <div>
            <h4 className="text-sm tracking-widest mb-4 font-display">FOLLOW US</h4>
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
        <div className="flex flex-col md:flex-row justify-between items-center gap-4 w-full">
          <p className="text-xs text-white/50">© 2026 Le Fil des Heures. All rights reserved.</p>
          <div className="flex gap-6">
            <a className="text-xs text-white/50 hover:text-white transition-colors duration-300 cursor-pointer" href="/privacy">
              Privacy Policy
            </a>
            <a className="text-xs text-white/50 hover:text-white transition-colors duration-300 cursor-pointer" href="/terms">
              Terms of Service
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;