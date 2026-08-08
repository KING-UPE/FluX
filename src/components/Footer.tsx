"use client";

import React from "react";
import { useAppTheme } from "@/lib/themeContext";

const socialLinks = [
  {
    name: "GitHub",
    url: "https://github.com/KING-UPE",
    icon: (
      <svg viewBox="0 0 16 16" className="w-5 h-5 fill-current">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8" />
      </svg>
    ),
  },
  {
    name: "LinkedIn",
    url: "https://www.linkedin.com/in/upendra-dasanayaka/",
    icon: (
      <svg viewBox="0 0 19 18" className="w-5 h-5 fill-current">
        <path d="M6.55936 14.8711H4.09842V6.92578H6.55936V14.8711ZM6.8049 4.39439C6.8049 3.59885 6.15945 2.95312 5.36432 2.95312C4.56616 2.95312 3.92236 3.59885 3.92236 4.39439C3.92236 5.19022 4.56616 5.83594 5.36432 5.83594C6.15945 5.83594 6.8049 5.19022 6.8049 4.39439ZM15.77 10.4999C15.77 8.36705 15.3194 6.78516 12.8279 6.78516C11.6306 6.78516 10.827 7.38391 10.4989 8.00656H10.4966V6.92578H8.10596V14.8711H10.4966V10.9262C10.4966 9.89305 10.7596 8.8922 12.0402 8.8922C13.3033 8.8922 13.3442 10.0736 13.3442 10.9918V14.8711H15.77V10.4999ZM18.9341 15.8906V2.10938C18.9341 0.946198 17.9879 0 16.8247 0H3.04346C1.88028 0 0.934082 0.946198 0.934082 2.10938V15.8906C0.934082 17.0538 1.88028 18 3.04346 18H16.8247C17.9879 18 18.9341 17.0538 18.9341 15.8906ZM16.8247 1.40625C17.2124 1.40625 17.5278 1.72169 17.5278 2.10938V15.8906C17.5278 16.2783 17.2124 16.5938 16.8247 16.5938H3.04346C2.65578 16.5938 2.34033 16.2783 2.34033 15.8906V2.10938C2.34033 1.72169 2.65578 1.40625 3.04346 1.40625H16.8247Z" />
      </svg>
    ),
  },
  {
    name: "YouTube",
    url: "https://www.youtube.com/@upendra_dasanayaka",
    icon: (
      <svg viewBox="0 0 16 16" className="w-5 h-5 fill-current">
        <path d="M8.051 1.999h.089c.822.003 4.987.033 6.11.335a2.01 2.01 0 0 1 1.415 1.42c.101.38.172.883.22 1.402l.01.104.022.26.008.104c.065.914.073 1.77.074 1.957v.075c-.001.194-.01 1.108-.082 2.06l-.008.105-.009.104c-.05.572-.124 1.14-.235 1.558a2.01 2.01 0 0 1-1.415 1.42c-1.16.312-5.569.334-6.18.335h-.142c-.309 0-1.587-.006-2.927-.052l-.17-.006-.087-.004-.171-.007-.171-.007c-1.11-.049-2.167-.128-2.654-.26a2.01 2.01 0 0 1-1.415-1.419c-.111-.417-.185-.986-.235-1.558L.09 9.82l-.008-.104A31 31 0 0 1 0 7.68v-.123c.002-.215.01-.958.064-1.778l.007-.103.003-.052.008-.104.022-.26.01-.104c.048-.519.119-1.023.22-1.402a2.01 2.01 0 0 1 1.415-1.42c.487-.13 1.544-.21 2.654-.26l.17-.007.172-.006.086-.003.171-.007A100 100 0 0 1 7.858 2zM6.4 5.209v4.818l4.157-2.408z" />
      </svg>
    ),
  },
  {
    name: "Facebook",
    url: "https://web.facebook.com/UpendraDasanayak/",
    icon: (
      <svg viewBox="0 0 16 16" className="w-5 h-5 fill-current">
        <path d="M16 8.049c0-4.446-3.582-8.05-8-8.05C3.58 0-.002 3.603-.002 8.05c0 4.017 2.926 7.347 6.75 7.951v-5.625h-2.03V8.05H6.75V6.275c0-2.017 1.195-3.131 3.022-3.131.876 0 1.791.157 1.791.157v1.98h-1.009c-.993 0-1.303.621-1.303 1.258v1.51h2.218l-.354 2.326H9.25V16c3.824-.604 6.75-3.934 6.75-7.951" />
      </svg>
    ),
  },
  {
    name: "Instagram",
    url: "https://www.instagram.com/upendra_dasanayaka/",
    icon: (
      <svg viewBox="0 0 16 16" className="w-5 h-5 fill-current">
        <path d="M8 0C5.829 0 5.556.01 4.703.048 3.85.088 3.269.222 2.76.42a3.9 3.9 0 0 0-1.417.923A3.9 3.9 0 0 0 .42 2.76C.222 3.268.087 3.85.048 4.7.01 5.555 0 5.827 0 8.001c0 2.172.01 2.444.048 3.297.04.852.174 1.433.372 1.942.205.526.478.972.923 1.417.444.445.89.719 1.416.923.51.198 1.09.333 1.942.372C5.555 15.99 5.827 16 8 16s2.444-.01 3.298-.048c.851-.04 1.434-.174 1.943-.372a3.9 3.9 0 0 0 1.416-.923c.445-.445.718-.891.923-1.417.197-.509.332-1.09.372-1.942C15.99 10.445 16 10.173 16 8s-.01-2.445-.048-3.299c-.04-.851-.175-1.433-.372-1.941a3.9 3.9 0 0 0-.923-1.417A3.9 3.9 0 0 0 13.24.42c-.51-.198-1.092-.333-1.943-.372C10.443.01 10.172 0 7.998 0zm-.717 1.442h.718c2.136 0 2.389.007 3.232.046.78.035 1.204.166 1.486.275.373.145.64.319.92.599s.453.546.598.92c.11.281.24.705.275 1.485.039.843.047 1.096.047 3.231s-.008 2.389-.047 3.232c-.035.78-.166 1.203-.275 1.485a2.5 2.5 0 0 1-.599.919c-.28.28-.546.453-.92.598-.28.11-.704.24-1.485.276-.843.038-1.096.047-3.232.047s-2.39-.009-3.233-.047c-.78-.036-1.203-.166-1.485-.276a2.5 2.5 0 0 1-.92-.598 2.5 2.5 0 0 1-.6-.92c-.109-.281-.24-.705-.275-1.485-.038-.843-.046-1.096-.046-3.233s.008-2.388.046-3.231c.036-.78.166-1.204.276-1.486.145-.373.319-.64.599-.92s.546-.453.92-.598c.282-.11.705-.24 1.485-.276.738-.034 1.024-.044 2.515-.045zm4.988 1.328a.96.96 0 1 0 0 1.92.96.96 0 0 0 0-1.92m-4.27 1.122a4.109 4.109 0 1 0 0 8.217 4.109 4.109 0 0 0 0-8.217m0 1.441a2.667 2.667 0 1 1 0 5.334 2.667 2.667 0 0 1 0-5.334" />
      </svg>
    ),
  },
];

const Footer = () => {
  const { theme } = useAppTheme();
  const { themeText, accent } = theme;

  return (
    <footer className="w-full py-8 mt-auto border-t border-white/5 bg-black/20 backdrop-blur-sm">
      <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-6">
        {/* Credits */}
        <div className="flex flex-col items-center md:items-start gap-1">
          <p className="text-white/40 text-sm font-medium">
            © {new Date().getFullYear()} Flux. All rights reserved.
          </p>
          <p className="text-white/60 text-sm">
            Developed by{" "}
            <a
              href="https://upendradasanayaka.vercel.app"
              target="_blank"
              rel="noopener noreferrer"
              className={`${themeText} transition-colors duration-500 font-semibold hover:opacity-80`}
            >
              Upendra Dasanayaka
            </a>
          </p>
        </div>

        {/* Social Links */}
        <div className="flex items-center gap-3">
          {socialLinks.map((link) => (
            <a
              key={link.name}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={link.name}
              className={`p-2 rounded-lg bg-white/5 border border-white/10 text-white/40 transition-all duration-500 group ${themeText} hover:opacity-100`}
              style={{ borderColor: "rgba(255,255,255,0.1)" }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor = accent + "80";
                (e.currentTarget as HTMLElement).style.boxShadow = `0 0 12px ${accent}40`;
                (e.currentTarget as HTMLElement).style.color = accent;
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,255,255,0.1)";
                (e.currentTarget as HTMLElement).style.boxShadow = "none";
                (e.currentTarget as HTMLElement).style.color = "";
              }}
            >
              {link.icon}
            </a>
          ))}
        </div>
      </div>
    </footer>
  );
};

export default Footer;
