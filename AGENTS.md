# me-da-mimo — instruções para agentes

PWA de lista de presentes de Natal em família (GitHub Pages + Supabase)

## Memória do projeto
`.brain/` = notas do projeto no brain compartilhado (`~/brain/projects/me-da-mimo/`). Comece por `.brain/00-INDEX.md` (tabela tarefa → nota → código) e leia só a seção necessária: `grep -n '^## ' .brain/<Nota>.md` → `sed -n 'A,Bp'`.
Regras do projeto: `.brain/Regras.md`. Regras globais e protocolo: skill `brain` (`~/brain/_system/skills/brain/SKILL.md`).

## Ao terminar
Grave de volta 1–3 linhas: bug → `.brain/Bugs-resolvidos.md` · armadilha → `.brain/Gotchas.md` · decisão → `.brain/Decisoes.md` · progresso → `.brain/Status-e-roadmap.md` + `.brain/sessoes/AAAA-MM-DD.md`.
