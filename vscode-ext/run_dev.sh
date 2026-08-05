rm *.vsix
npm run package
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension ~/Work/UniNotepad/vscode-ext/uninotepad-markdown-preview-*.vsix
