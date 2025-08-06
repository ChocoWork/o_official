import React from "react";
import styles from "./FilterSidebar.module.css";

interface FilterSidebarProps {
  open: boolean;
  onClose: () => void;
}

const FilterSidebar: React.FC<FilterSidebarProps> = ({ open, onClose }) => {
  return (
    <div className={open ? styles.sidebarOpen : styles.sidebarClosed}>
      <button className={styles.closeButton} onClick={onClose}>×</button>
      <div className={styles.content}>
        {/* ここにフィルターUIを追加 */}
        <h2>フィルター</h2>
        {/* 例: チェックボックスやセレクトボックスなど */}
      </div>
    </div>
  );
};

export default FilterSidebar;
