; design 21 M4 / C19: remove the per-user login-autostart Run value during
; uninstall. Electron's setLoginItemSettings on Windows writes the Run key
; under the app's resolved name; delete both the product name and the
; workspace-scoped fallback (absent values are a silent no-op).
;
; electron-builder NSIS build.nsis.include — the macro bodies below are
; invoked only when the packaged installer defines them; an unknown name here
; is inert, so this file is safe for both stable and beta channel builds.
; (Verified at packaging time on the Windows build leg — M0.5 实证项.)

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "dsh-chamber"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "@dsh-chamber/desktop"
!macroend
