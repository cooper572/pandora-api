@echo off

echo Setting up remotes...

git remote remove github 2>nul
git remote add github https://github.com/vyla-entertainment/stream-api

git remote remove hf 2>nul
git remote add hf https://huggingface.co/spaces/MissouriMonster/vyla

echo Pushing to GitHub...
git push github main --force

echo Pushing to Hugging Face...
git push hf main --force

echo Done! Both repositories updated.