import React from 'react';

const Footer = () => {
  return (
    <footer className="bg-black text-white py-16 px-6 lg:px-12 w-full">
      <div className="w-full">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-12 mb-12 w-full">
          <div>
            <h3 className="text-2xl mb-6 tracking-tight" style={{ fontFamily: 'Didot, serif' }}>Le Fil des Heures</h3>
            <p className="text-sm text-white/70 leading-relaxed" style={{ fontFamily: 'acumin-pro, sans-serif' }}>時を紡ぐニュートラルモードな日常着</p>
          </div>
          <div>
            <h4 className="text-sm tracking-widest mb-4" style={{ fontFamily: 'acumin-pro, sans-serif' }}>SHOP</h4>
            <ul className="space-y-2">
              <li><a className="text-sm text-white/70 hover:text-white transition-colors duration-300 cursor-pointer" href="/item" style={{ fontFamily: 'acumin-pro, sans-serif' }}>ALL</a></li>
              <li><a className="text-sm text-white/70 hover:text-white transition-colors duration-300 cursor-pointer" href="/item" style={{ fontFamily: 'acumin-pro, sans-serif' }}>TOPS</a></li>
              <li><a className="text-sm text-white/70 hover:text-white transition-colors duration-300 cursor-pointer" href="/item" style={{ fontFamily: 'acumin-pro, sans-serif' }}>BOTTOMS</a></li>
              <li><a className="text-sm text-white/70 hover:text-white transition-colors duration-300 cursor-pointer" href="/item" style={{ fontFamily: 'acumin-pro, sans-serif' }}>OUTERWEAR</a></li>
              <li><a className="text-sm text-white/70 hover:text-white transition-colors duration-300 cursor-pointer" href="/item" style={{ fontFamily: 'acumin-pro, sans-serif' }}>ACCESSORIES</a></li>
            </ul>
          </div>
          <div>
            <h4 className="text-sm tracking-widest mb-4" style={{ fontFamily: 'acumin-pro, sans-serif' }}>INFORMATION</h4>
            <ul className="space-y-2">
              <li><a className="text-sm text-white/70 hover:text-white transition-colors duration-300 cursor-pointer" href="/about" style={{ fontFamily: 'acumin-pro, sans-serif' }}>ABOUT</a></li>
              <li><a className="text-sm text-white/70 hover:text-white transition-colors duration-300 cursor-pointer" href="/look" style={{ fontFamily: 'acumin-pro, sans-serif' }}>LOOK</a></li>
              <li><a className="text-sm text-white/70 hover:text-white transition-colors duration-300 cursor-pointer" href="/news" style={{ fontFamily: 'acumin-pro, sans-serif' }}>NEWS</a></li>
              <li><a className="text-sm text-white/70 hover:text-white transition-colors duration-300 cursor-pointer" href="/stockist" style={{ fontFamily: 'acumin-pro, sans-serif' }}>STOCKIST</a></li>
              <li><a className="text-sm text-white/70 hover:text-white transition-colors duration-300 cursor-pointer" href="/contact" style={{ fontFamily: 'acumin-pro, sans-serif' }}>CONTACT</a></li>
            </ul>
          </div>
          <div>
            <h4 className="text-sm tracking-widest mb-4" style={{ fontFamily: 'acumin-pro, sans-serif' }}>FOLLOW US</h4>
            <div className="flex gap-4">
              <a href="#" className="w-10 h-10 flex items-center justify-center border border-white hover:bg-white hover:text-black transition-all duration-300 cursor-pointer">
                <i className="ri-instagram-line text-xl"></i>
              </a>
              <a href="#" className="w-10 h-10 flex items-center justify-center border border-white hover:bg-white hover:text-black transition-all duration-300 cursor-pointer">
                <i className="ri-facebook-line text-xl"></i>
              </a>
              <a href="#" className="w-10 h-10 flex items-center justify-center border border-white hover:bg-white hover:text-black transition-all duration-300 cursor-pointer">
                <i className="ri-twitter-x-line text-xl"></i>
              </a>
            </div>
          </div>
        </div>
        <div className="border-t border-white/20 pt-8 flex flex-col md:flex-row justify-between items-center gap-4 w-full">
          <p className="text-xs text-white/50" style={{ fontFamily: 'acumin-pro, sans-serif' }}>© 2024 Le Fil des Heures. All rights reserved.</p>
          <div className="flex gap-6">
            <a className="text-xs text-white/50 hover:text-white transition-colors duration-300 cursor-pointer" href="/privacy" style={{ fontFamily: 'acumin-pro, sans-serif' }}>Privacy Policy</a>
            <a className="text-xs text-white/50 hover:text-white transition-colors duration-300 cursor-pointer" href="/terms" style={{ fontFamily: 'acumin-pro, sans-serif' }}>Terms of Service</a>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;