import os
from PIL import Image

src_path = r"f:\项目\tagtime\apps\web\public\logo.png"
res_dir = r"f:\项目\tagtime\apps\web\android\app\src\main\res"

if not os.path.exists(src_path):
    print("Error: logo.png not found")
    exit(1)

src_img = Image.open(src_path).convert("RGBA")

# Mipmap dimensions: (dir_name, icon_size, fg_size)
densities = [
    ("mipmap-mdpi", 48, 108),
    ("mipmap-hdpi", 72, 162),
    ("mipmap-xhdpi", 96, 216),
    ("mipmap-xxhdpi", 144, 324),
    ("mipmap-xxxhdpi", 192, 432),
]

for dir_name, icon_size, fg_size in densities:
    target_dir = os.path.join(res_dir, dir_name)
    os.makedirs(target_dir, exist_ok=True)
    
    # 1. Square / Round Launcher Icon (ic_launcher.png & ic_launcher_round.png)
    # Resize keeping aspect ratio, fitted into square with optional padding or clean fill
    icon_img = Image.new("RGBA", (icon_size, icon_size), (255, 255, 255, 0))
    resized_src = src_img.copy()
    resized_src.thumbnail((icon_size, icon_size), Image.Resampling.LANCZOS)
    
    # Center in canvas
    offset_x = (icon_size - resized_src.width) // 2
    offset_y = (icon_size - resized_src.height) // 2
    icon_img.paste(resized_src, (offset_x, offset_y), resized_src)
    
    icon_img.save(os.path.join(target_dir, "ic_launcher.png"))
    icon_img.save(os.path.join(target_dir, "ic_launcher_round.png"))
    
    # 2. Foreground for Adaptive Icon (ic_launcher_foreground.png)
    # Adaptive icons have safe zone in center (~66% of total width/height)
    fg_img = Image.new("RGBA", (fg_size, fg_size), (0, 0, 0, 0))
    fg_logo_size = int(fg_size * 0.65)
    resized_fg_src = src_img.copy()
    resized_fg_src.thumbnail((fg_logo_size, fg_logo_size), Image.Resampling.LANCZOS)
    
    fg_offset_x = (fg_size - resized_fg_src.width) // 2
    fg_offset_y = (fg_size - resized_fg_src.height) // 2
    fg_img.paste(resized_fg_src, (fg_offset_x, fg_offset_y), resized_fg_src)
    
    fg_img.save(os.path.join(target_dir, "ic_launcher_foreground.png"))

print("All Android launcher icons generated successfully!")
