include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-skywifi
PKG_VERSION:=2.2.0
PKG_RELEASE:=3

include $(INCLUDE_DIR)/package.mk

define Package/luci-app-skywifi
  SECTION:=luci
  CATEGORY:=LuCI
  TITLE:=Sky Wifi
  PKGARCH:=all
  DEPENDS:=+luci-base +nftables +uhttpd +hostapd-utils +iw
endef

define Package/luci-app-skywifi/description
 Sky Wifi traffic monitoring, bandwidth QoS, website blocking and captive portal.
endef

define Package/luci-app-skywifi/conffiles
/etc/config/skywifi
endef

define Package/luci-app-skywifi/install
	$(CP) ./files/* $(1)/
	chmod 0755 $(1)/www/cgi-bin/skywifi/portal
	chmod 0755 $(1)/www/cgi-bin/skywifi/terms
endef

# SkyWifi is a files-only package; there is no upstream source tree to compile.
define Build/Compile
	:
endef

$(eval $(call BuildPackage,luci-app-skywifi))
