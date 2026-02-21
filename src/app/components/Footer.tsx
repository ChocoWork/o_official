import React from 'react';

const Footer = () => {
  return (
    <footer className="bg-black text-white py-8 px-6 lg:px-12 w-full font-brand">
      <div className="w-full">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-12 mb-8 w-full">
          <div>
            <h3 className="text-2xl mb-6 tracking-tight font-display">Le Fil des Heures</h3>
            <p className="text-sm text-white/70 leading-relaxed">時を紡ぐニュートラルモードな日常着</p>
          </div>
          <div>
            <h4 className="text-sm tracking-widest mb-4">SHOP</h4>
            <ul className="space-y-2">
              <li><a className="text-sm text-white/70 hover:text-white transition-colors duration-300 cursor-pointer" href="/item">ALL</a></li>
              <li><a className="text-sm text-white/70 hover:text-white transition-colors duration-300 cursor-pointer" href="/item">TOPS</a></li>
              <li><a className="text-sm text-white/70 hover:text-white transition-colors duration-300 cursor-pointer" href="/item">BOTTOMS</a></li>
              <li><a className="text-sm text-white/70 hover:text-white transition-colors duration-300 cursor-pointer" href="/item">OUTERWEAR</a></li>
              <li><a className="text-sm text-white/70 hover:text-white transition-colors duration-300 cursor-pointer" href="/item">ACCESSORIES</a></li>
            </ul>
          </div>
          <div>
            <h4 className="text-sm tracking-widest mb-4">INFORMATION</h4>
            <ul className="space-y-2">
              <li><a className="text-sm text-white/70 hover:text-white transition-colors duration-300 cursor-pointer" href="/about">ABOUT</a></li>
              <li><a className="text-sm text-white/70 hover:text-white transition-colors duration-300 cursor-pointer" href="/look">LOOK</a></li>
              <li><a className="text-sm text-white/70 hover:text-white transition-colors duration-300 cursor-pointer" href="/news">NEWS</a></li>
              <li><a className="text-sm text-white/70 hover:text-white transition-colors duration-300 cursor-pointer" href="/stockist">STOCKIST</a></li>
              <li><a className="text-sm text-white/70 hover:text-white transition-colors duration-300 cursor-pointer" href="/contact">CONTACT</a></li>
            </ul>
          </div>
          <div>
            <h4 className="text-sm tracking-widest mb-4">FOLLOW US</h4>
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
        <div className="flex flex-col md:flex-row justify-between items-center gap-4 w-full">
          <p className="text-xs text-white/50">© 2024 Le Fil des Heures. All rights reserved.</p>
          <div className="flex gap-6">
            <a className="text-xs text-white/50 hover:text-white transition-colors duration-300 cursor-pointer" href="/privacy">Privacy Policy</a>
            <a className="text-xs text-white/50 hover:text-white transition-colors duration-300 cursor-pointer" href="/terms">Terms of Service</a>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;